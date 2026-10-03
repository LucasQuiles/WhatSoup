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

  it('keeps the agreed seven-day window', () => {
    // The fixtures above follow the constant, so only this pins its value. The
    // cutoff itself is inclusive; equality at the cutoff is not tested because
    // the SQL reads datetime('now').
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
