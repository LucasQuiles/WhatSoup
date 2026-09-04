import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../src/core/database.ts';
import { reconcileOperatorCatchupRecoveries } from '../../src/core/recovery-catchup-closure.ts';

describe('automatic operator catch-up reconciler', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('auto-closes a group once its conversation has a delivered catch-up', () => {
    const fixture = installFixture({ echoed: true });

    const report = reconcileOperatorCatchupRecoveries(db.raw);

    expect(report).toMatchObject({
      attempted: 1,
      closed: 1,
      linksClosed: 2,
      skipped: 0,
    });
    expect(report.skips).toEqual([]);
    // Both source links are now superseded against the catch-up target.
    expect(linkRows('superseded_by_operator_catchup')).toEqual([
      { inbound_seq: fixture.sourceSeqs[0], superseded_by_seq: fixture.catchupSeq },
      { inbound_seq: fixture.sourceSeqs[1], superseded_by_seq: fixture.catchupSeq },
    ]);
    // Closed by the reconciler actor, not an operator.
    expect(closureActors()).toEqual(['auto_reconciler', 'auto_reconciler']);
  });

  it('leaves a group pending when no delivered catch-up exists yet', () => {
    installFixture({ echoed: false });

    const report = reconcileOperatorCatchupRecoveries(db.raw);

    expect(report).toMatchObject({ attempted: 0, closed: 0, linksClosed: 0, skipped: 1 });
    expect(report.skips).toEqual([
      expect.objectContaining({ reason: 'no_catchup_candidate', nSourceSeqs: 2 }),
    ]);
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);
  });

  it('is idempotent: a second pass finds nothing left to close', () => {
    installFixture({ echoed: true });

    const first = reconcileOperatorCatchupRecoveries(db.raw);
    expect(first).toMatchObject({ closed: 1 });

    const second = reconcileOperatorCatchupRecoveries(db.raw);
    expect(second).toMatchObject({ attempted: 0, closed: 0, linksClosed: 0, skipped: 0 });
    expect(second.skips).toEqual([]);
  });

  it('closes independent groups and honours the group limit', () => {
    installFixture({ echoed: true, planId: 'plan-a', conversationKey: 'conv-a', chat: 'a@g.us' });
    installFixture({ echoed: true, planId: 'plan-b', conversationKey: 'conv-b', chat: 'b@g.us' });

    const bounded = reconcileOperatorCatchupRecoveries(db.raw, { groupLimit: 1 });
    expect(bounded).toMatchObject({ closed: 1, linksClosed: 2 });
    // One group remains for the next pass.
    expect(linkRows('superseded_by_operator_catchup')).toHaveLength(2);

    const rest = reconcileOperatorCatchupRecoveries(db.raw);
    expect(rest).toMatchObject({ closed: 1, linksClosed: 2 });
    expect(linkRows('superseded_by_operator_catchup')).toHaveLength(4);
  });

  it('rejects a non-positive group limit', () => {
    expect(() => reconcileOperatorCatchupRecoveries(db.raw, { groupLimit: 0 }))
      .toThrow(/group limit must be a positive safe integer/i);
  });

  // -------------------------------------------------------------------------
  // Fail-closed skip classification. These exercise the try/catch path around
  // closeOperatorCatchupRecoveryRaw — the reconciler's core safety claim that a
  // bad or blocked selection records a bounded skip instead of corrupting state.
  // -------------------------------------------------------------------------

  it('fails a mixed-chat_jid group closed at the DB trigger and records a bounded closure_rejected skip', () => {
    // Two source inbounds share one conversation_key but sit on different
    // chat_jids; a single catch-up target can only carry a delivery proof for
    // its own chat_jid, so the trigger RAISE(ABORT)s the mismatched row. The
    // whole closure rolls back — no partial close — and is classified benign.
    installFixture({ echoed: true, sourceChats: ['reconciler@g.us', 'other@g.us'] });

    const report = reconcileOperatorCatchupRecoveries(db.raw);

    // A candidate proof exists (for the target's own chat_jid), so a closure IS
    // attempted — this reaches the catch block, unlike no_catchup_candidate.
    expect(report).toMatchObject({ attempted: 1, closed: 0, linksClosed: 0, skipped: 1 });
    expect(report.skips).toEqual([
      expect.objectContaining({ reason: 'closure_rejected', nSourceSeqs: 2 }),
    ]);
    // Fail-closed: the whole transaction rolled back, so NEITHER source closed.
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);
    // And both remain pending for a (correct) future manual disposition.
    expect(linkRows('recovery_pending_operator_catchup')).toHaveLength(2);
  });

  it('classifies a write-locked database as a benign busy skip and closes nothing', () => {
    // The reconciler's plain-read enumeration succeeds under WAL, but the
    // per-group closure opens BEGIN IMMEDIATE — which loses to a competing
    // writer and returns SQLITE_BUSY. With busy_timeout=0 this is immediate and
    // deterministic. Requires a file DB: two connections cannot share :memory:.
    const dir = mkdtempSync(join(tmpdir(), 'reconciler-busy-'));
    const dbPath = join(dir, 'bot.db');
    const fileDb = new Database(dbPath);
    fileDb.open();
    let blocker: DatabaseSync | undefined;
    try {
      installFixture({ echoed: true, into: fileDb });

      // Hold the write lock on a second connection.
      blocker = new DatabaseSync(dbPath);
      blocker.exec('PRAGMA busy_timeout = 0');
      blocker.exec('BEGIN IMMEDIATE');

      // Fail fast instead of waiting out the 5s default busy_timeout.
      fileDb.raw.exec('PRAGMA busy_timeout = 0');
      const report = reconcileOperatorCatchupRecoveries(fileDb.raw);

      expect(report).toMatchObject({ attempted: 1, closed: 0, linksClosed: 0, skipped: 1 });
      expect(report.skips).toEqual([
        expect.objectContaining({ reason: 'busy', nSourceSeqs: 2 }),
      ]);

      // Release the lock; a retry now succeeds — the skip was transient, not terminal.
      blocker.exec('ROLLBACK');
      blocker.close();
      blocker = undefined;
      const retry = reconcileOperatorCatchupRecoveries(fileDb.raw);
      expect(retry).toMatchObject({ attempted: 1, closed: 1, linksClosed: 2, skipped: 0 });
    } finally {
      try { blocker?.close(); } catch { /* already closed */ }
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Fixture: two crash-failed source inbounds pending catch-up, plus a later
  // catch-up inbound whose terminal reply is (optionally) echoed — mirrors
  // tests/core/recovery-catchup-closure.test.ts installFixture.
  // -------------------------------------------------------------------------
  function installFixture(options: {
    echoed: boolean;
    planId?: string;
    conversationKey?: string;
    chat?: string;
    /**
     * Per-source chat_jid override. Length must match the two source inbounds.
     * When a source's chat_jid differs from the catch-up target's chat_jid the
     * closure trigger fails that row closed (see the multi-chat_jid test).
     */
    sourceChats?: [string, string];
    /** Target database. Defaults to the in-memory `db`; a file DB is used for lock tests. */
    into?: Database;
  }): { planId: string; conversationKey: string; sourceSeqs: number[]; catchupSeq: number } {
    const raw = (options.into ?? db).raw;
    const planId = options.planId ?? 'pcr-reconciler';
    const conversationKey = options.conversationKey ?? 'reconciler-conversation';
    const chat = options.chat ?? 'reconciler@g.us';
    const sourceChats = options.sourceChats ?? [chat, chat];
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'pre_connect_recovery', 'system:test', 'fixture', 'test://fixture')
    `).run(planId);
    const sourceSeqs = ['source-one', 'source-two'].map((messageId, index) => Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(`${planId}-${messageId}`, conversationKey, sourceChats[index]).lastInsertRowid));
    const insertPending = raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'crash recovery', 'test://fixture', 'system:test')
    `);
    for (const seq of sourceSeqs) insertPending.run(seq, planId);

    const catchupSeq = Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
    `).run(`${planId}-catchup`, conversationKey, chat).lastInsertRowid);
    const opId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
        is_terminal, replay_policy, echoed_at
      ) VALUES (?, ?, 'text', '{"text":"ACK"}', ?, ?, 1, 'unsafe',
                CASE WHEN ? = 'echoed' THEN datetime('now') ELSE NULL END)
    `).run(
      conversationKey,
      chat,
      options.echoed ? 'echoed' : 'submitted',
      catchupSeq,
      options.echoed ? 'echoed' : 'submitted',
    ).lastInsertRowid);
    raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, 'catchup-turn',
                'catchup-manager', 1, 'replied', 'finalized_replied',
                ?, ?, ?)
    `).run(
      conversationKey,
      chat,
      catchupSeq,
      catchupSeq,
      options.echoed ? 'echoed' : 'enqueued',
      opId,
      options.echoed ? 1 : 0,
    );
    return { planId, conversationKey, sourceSeqs, catchupSeq };
  }

  function linkRows(disposition: string): Array<{ inbound_seq: number; superseded_by_seq: number | null }> {
    return db.raw.prepare(`
      SELECT inbound_seq, superseded_by_seq
      FROM inbound_disposition_links
      WHERE disposition = ?
      ORDER BY inbound_seq
    `).all(disposition) as Array<{ inbound_seq: number; superseded_by_seq: number | null }>;
  }

  function closureActors(): string[] {
    return (db.raw.prepare(`
      SELECT actor
      FROM inbound_disposition_links
      WHERE disposition = 'superseded_by_operator_catchup'
      ORDER BY inbound_seq
    `).all() as Array<{ actor: string }>).map((row) => row.actor);
  }
});
