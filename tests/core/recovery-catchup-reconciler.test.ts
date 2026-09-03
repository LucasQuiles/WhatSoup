import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  // Fixture: two crash-failed source inbounds pending catch-up, plus a later
  // catch-up inbound whose terminal reply is (optionally) echoed — mirrors
  // tests/core/recovery-catchup-closure.test.ts installFixture.
  // -------------------------------------------------------------------------
  function installFixture(options: {
    echoed: boolean;
    planId?: string;
    conversationKey?: string;
    chat?: string;
  }): { planId: string; conversationKey: string; sourceSeqs: number[]; catchupSeq: number } {
    const planId = options.planId ?? 'pcr-reconciler';
    const conversationKey = options.conversationKey ?? 'reconciler-conversation';
    const chat = options.chat ?? 'reconciler@g.us';
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'pre_connect_recovery', 'system:test', 'fixture', 'test://fixture')
    `).run(planId);
    const sourceSeqs = ['source-one', 'source-two'].map((messageId) => Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(`${planId}-${messageId}`, conversationKey, chat).lastInsertRowid));
    const insertPending = db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'crash recovery', 'test://fixture', 'system:test')
    `);
    for (const seq of sourceSeqs) insertPending.run(seq, planId);

    const catchupSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
    `).run(`${planId}-catchup`, conversationKey, chat).lastInsertRowid);
    const opId = Number(db.raw.prepare(`
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
    db.raw.prepare(`
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
