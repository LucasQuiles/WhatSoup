/**
 * #3754: the windowed scheduled-turns-lost count, the index it reads through,
 * and the one synthetic-source predicate checked against the runtime's minted
 * id. The per-arm enrollment behaviour lives in synthetic-catchup-enrollment.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  SCHEDULED_TURN_LOSS_WINDOW_DAYS,
  SCHEDULED_TURNS_LOST_SQL,
} from '../../src/core/durability-recovery-evidence.ts';
import { classifyTurnLane } from '../../src/core/observability/lifecycle-emission.ts';
import {
  scheduledJobInboundMessageId,
  syntheticSourceMessageIdSql,
} from '../../src/core/synthetic-turn-source.ts';

const CONVERSATION_KEY = '15550137542';
const DELIVERY_JID = '15550137542@s.whatsapp.net';

describe('scheduled turns lost to crash recovery (#3754)', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  const failed = (messageId: string, failureClass: Parameters<DurabilityEngine['markInboundFailed']>[1]) => {
    const seq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    engine.markInboundFailed(seq, failureClass);
    return seq;
  };
  // Shift completed_at to the window edge, then an hour either side of it.
  const toWindowEdge = (seq: number, offset: '+1 hour' | '-1 hour') =>
    db.raw.prepare(`
      UPDATE inbound_events
      SET completed_at = datetime('now', '-${SCHEDULED_TURN_LOSS_WINDOW_DAYS} days', ?)
      WHERE seq = ?
    `).run(offset, seq);

  it('counts only reclaim-class synthetic failures inside the window', () => {
    const inside = failed(scheduledJobInboundMessageId(7, 1_780_000_001, 21), 'crash_recovery');
    const outside = failed(scheduledJobInboundMessageId(7, 1_780_000_002, 22), 'stale_reclaim');
    failed(scheduledJobInboundMessageId(7, 1_780_000_003, 23), 'timeout');
    failed('wamid-window-user', 'crash_recovery');
    failed(scheduledJobInboundMessageId(7, 1_780_000_004, 24), 'recovery_owner_reclaimed');
    toWindowEdge(inside, '+1 hour');
    toWindowEdge(outside, '-1 hour');

    // inside (crash_recovery) and the fresh recovery_owner_reclaimed row count;
    // the row past the window, the timeout class and the real user's turn do not.
    expect(engine.getTurnRecoverySupervisorCounts().scheduledTurnsLost).toBe(2);
  });

  it('counts a qualifying synthetic loss at the exact inclusive seven-day cutoff', () => {
    const atCutoff = failed(scheduledJobInboundMessageId(7, 1_780_000_005, 25), 'crash_recovery');
    const justBeforeCutoff = failed(scheduledJobInboundMessageId(7, 1_780_000_006, 26), 'crash_recovery');
    const cutoff = '2040-01-01 00:00:00';

    db.raw.prepare('UPDATE inbound_events SET completed_at = ? WHERE seq = ?').run(cutoff, atCutoff);
    db.raw.prepare('UPDATE inbound_events SET completed_at = ? WHERE seq = ?').run('2039-12-31 23:59:59', justBeforeCutoff);

    // SQLite's "now" is stable only within one statement. Freeze the exact
    // query clock so the edge comparison cannot cross a wall-clock second.
    db.raw.function('datetime', { varargs: true }, (...args) => {
      if (
        args.length === 2
        && args[0] === 'now'
        && args[1] === `-${SCHEDULED_TURN_LOSS_WINDOW_DAYS} days`
      ) return cutoff;
      throw new Error(`Unexpected datetime() arguments: ${JSON.stringify(args)}`);
    });
    // Construct after installing the function: this is the actual prepared
    // supervisor count statement, with a deterministic SQLite clock.
    const restarted = new DurabilityEngine(db);

    expect(restarted.getTurnRecoverySupervisorCounts().scheduledTurnsLost).toBe(1);
  });

  it('keeps the agreed seven-day window', () => {
    // The fixtures above follow the constant, so only this pins its value. The
    // deterministic cutoff case above separately pins inclusive equality.
    expect(SCHEDULED_TURN_LOSS_WINDOW_DAYS).toBe(7);
  });

  it('reads the count through the message_id unique index', () => {
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${SCHEDULED_TURNS_LOST_SQL}`).all() as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail)).toContain(
      'SEARCH inbound_events USING INDEX sqlite_autoindex_inbound_events_1 (message_id>? AND message_id<?)',
    );
  });

  describe('synthetic id parity', () => {
    const isSynthetic = (messageId: string) => (db.raw.prepare(`
      SELECT ${syntheticSourceMessageIdSql('probe.message_id')} AS synthetic
      FROM (SELECT ? AS message_id) AS probe
    `).get(messageId) as { synthetic: number }).synthetic;

    it('recognises the minted runtime id shape, and only that prefix', () => {
      const minted = scheduledJobInboundMessageId(12, 1_787_969_434, 7);

      expect(minted).toBe('agentjob-12-1787969434-occ7');
      expect(classifyTurnLane(minted)).toEqual({ lane: 'L-SCH', trigger_occurrence_id: '7' });
      expect(isSynthetic(minted)).toBe(1);
      expect(isSynthetic('AGENTJOB-12-1787969434-occ7')).toBe(0);
      expect(isSynthetic('wamid-agentjob-1')).toBe(0);
      expect(isSynthetic('agentjob')).toBe(0);
    });

    it('refuses a non-identifier column', () => {
      expect(() => syntheticSourceMessageIdSql('message_id) OR (1')).toThrow(
        'synthetic source SQL column must be an identifier',
      );
    });
  });
});
