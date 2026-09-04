import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DEFAULT_DATABASE_RETENTION,
  runDatabaseRetention,
} from '../../src/core/database-retention.ts';
import { DeferredTurnStore } from '../../src/core/deferred-turn-store.ts';

/**
 * #3295 leaf L1 — acceptance criterion C10 / required behaviour RB8:
 * "Retention cannot delete the source inbound or replay envelope while a
 * deferred obligation remains non-terminal."
 *
 * The hazard pinned here is NOT the S2 admission path — that leaves the journal
 * row `processing`, which the sweep's own `processing_status IN ('complete',
 * 'failed')` filter already excludes. It is the state the S3 drain supervisor
 * creates: an obligation at `dispatched_commit` (non-terminal, replay still
 * owed) whose source inbound legitimately reads `complete`. Before this guard
 * the sweep deletes the source evidence out from under an obligation that can
 * still be requeued, quarantined, or operator-terminalized.
 *
 * The oracle for "terminal" is the issue's lifecycle spec, restated here rather
 * than imported, so a wrong status list in either the store or the retention
 * sweep fails this test instead of agreeing with it.
 */

const SCOPE = 'per_chat';

/** Absorbing states of the migration-62 lifecycle (#3295 S1). */
const SPEC_TERMINAL_STATUSES = [
  'terminal_completed',
  'terminal_operator',
  'terminal_quarantined',
];

/** Every state the migration-62 CHECK admits. */
const SPEC_ALL_STATUSES = [
  'claimed',
  'dispatched_commit',
  'pending',
  ...SPEC_TERMINAL_STATUSES,
];

describe('database retention — deferred-turn obligation hold (#3295 C10)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  /** An aged, terminally-processed inbound: prunable unless something holds it. */
  function insertAgedInbound(messageId: string): number {
    const row = db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES (?, 'conv-1', 'chat@g.us', 'complete', datetime('now', '-40 days'))
      RETURNING seq
    `).get(messageId) as { seq: number };
    return row.seq;
  }

  function insertObligation(inboundSeq: number, status: string, scope = SCOPE): void {
    db.raw.prepare(`
      INSERT INTO deferred_turn_obligations (
        scope, conversation_key, delivery_jid, inbound_seq, source_message_id,
        received_at_unix, replay_safe, sender_jid, replay_text, is_group,
        content_type, status
      ) VALUES (?, 'conv-1', 'chat@g.us', ?, ?, 1700000000, 1, 'sender-jid-placeholder',
                'envelope text', 0, 'text', ?)
    `).run(scope, inboundSeq, `msg-${scope}-${inboundSeq}`, status);
  }

  function survivingMessageIds(): string[] {
    return (db.raw.prepare('SELECT message_id FROM inbound_events ORDER BY seq').all() as Array<{
      message_id: string;
    }>).map((r) => r.message_id);
  }

  function sweep() {
    return runDatabaseRetention(db, { ...DEFAULT_DATABASE_RETENTION, terminalDurabilityDays: 30 });
  }

  /**
   * Coverage assertion (not a positive control): the status domain is read back
   * from the live CHECK constraint, so a seventh status added by a later leaf
   * fails HERE rather than silently escaping the per-status cases below.
   */
  it('the schema status domain is exactly the set these tests enumerate', () => {
    const sql = (db.raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deferred_turn_obligations'",
    ).get() as { sql: string } | undefined)?.sql;
    expect(sql).toBeTypeOf('string');
    const checkClause =
      /status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'pending'\s*CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i
        .exec(sql as string);
    expect(checkClause).not.toBeNull();
    const schemaStatuses = (checkClause as RegExpExecArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter((s) => s !== '');
    expect([...schemaStatuses].sort()).toEqual([...SPEC_ALL_STATUSES].sort());
  });

  it('holds the source inbound while an obligation is non-terminal and prunes the rest', () => {
    const heldSeq = insertAgedInbound('held-in');
    insertObligation(heldSeq, 'dispatched_commit');
    const terminalSeq = insertAgedInbound('terminal-obligation-in');
    insertObligation(terminalSeq, 'terminal_completed');
    insertAgedInbound('no-obligation-in');

    const result = sweep();

    expect(result.inboundEvents).toBe(2);
    expect(survivingMessageIds()).toEqual(['held-in']);
  });

  it('holds the replay envelope while the obligation is non-terminal', () => {
    const heldSeq = insertAgedInbound('held-envelope-in');
    insertObligation(heldSeq, 'dispatched_commit');

    sweep();

    const envelope = db.raw.prepare(
      'SELECT inbound_seq, status, replay_text FROM deferred_turn_obligations WHERE inbound_seq = ?',
    ).get(heldSeq) as { inbound_seq: number; status: string; replay_text: string } | undefined;
    expect(envelope).toEqual({
      inbound_seq: heldSeq,
      status: 'dispatched_commit',
      replay_text: 'envelope text',
    });
    expect(survivingMessageIds()).toEqual(['held-envelope-in']);
  });

  it.each(SPEC_ALL_STATUSES)(
    'status %s holds the inbound exactly when the spec calls it non-terminal',
    (status) => {
      const expectedHeld = !SPEC_TERMINAL_STATUSES.includes(status);
      const seq = insertAgedInbound(`in-${status}`);
      insertObligation(seq, status);

      // The store's scope-qualified predicate and the scope-agnostic retention
      // guard are separate implementations; both must match the spec oracle.
      expect(new DeferredTurnStore(db).hasNonTerminalObligation(SCOPE, seq)).toBe(expectedHeld);

      const result = sweep();

      expect(result.inboundEvents).toBe(expectedHeld ? 0 : 1);
      expect(survivingMessageIds()).toEqual(expectedHeld ? [`in-${status}`] : []);
    },
  );

  it('an inbound with no obligation is deleted exactly as before', () => {
    insertAgedInbound('plain-in');

    const result = sweep();

    expect(result.inboundEvents).toBe(1);
    expect(survivingMessageIds()).toEqual([]);
  });

  it('holds the inbound when the non-terminal obligation belongs to another scope class', () => {
    const seq = insertAgedInbound('other-scope-in');
    insertObligation(seq, 'pending', 'shared');

    const result = sweep();

    expect(result.inboundEvents).toBe(0);
    expect(survivingMessageIds()).toEqual(['other-scope-in']);
  });
});
