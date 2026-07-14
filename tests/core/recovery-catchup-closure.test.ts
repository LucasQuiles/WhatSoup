import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  closeOperatorCatchupRecovery,
  inspectOperatorCatchupRecovery,
} from '../../src/core/recovery-catchup-closure.ts';

describe('operator catch-up recovery closure', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('atomically closes the exact open source set only after an echoed catch-up reply', () => {
    const fixture = installFixture('complete', true);

    const receipt = closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://echoed-ack',
    });

    expect(receipt).toEqual({
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      sourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://echoed-ack',
      evidenceBasis: 'selected_echoed',
      terminalRecordId: fixture.terminalRecordId,
      selectedOpId: fixture.opId,
      recoveryJobId: null,
      completionProofId: null,
      inserted: 2,
      idempotent: false,
      openBefore: 2,
      openAfter: 0,
    });
    expect(linkRows('recovery_pending_operator_catchup')).toHaveLength(2);
    expect(linkRows('superseded_by_operator_catchup')).toEqual([
      { inbound_seq: fixture.sourceSeqs[0], superseded_by_seq: fixture.catchupSeq },
      { inbound_seq: fixture.sourceSeqs[1], superseded_by_seq: fixture.catchupSeq },
    ]);

    expect(closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://echoed-ack',
    })).toMatchObject({ inserted: 0, idempotent: true, openBefore: 0, openAfter: 0 });
  });

  it('rejects read-only inspection when the canonical schema-43 contract has drifted', () => {
    const fixture = installFixture('complete', true);
    db.raw.exec(`
      DROP TRIGGER operator_catchup_closure_witness_append_only_update;
      CREATE TRIGGER operator_catchup_closure_witness_append_only_update
      BEFORE UPDATE ON operator_catchup_closure_witnesses
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() => inspectOperatorCatchupRecovery(db.raw, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://schema-attestation',
    })).toThrow(/canonical schema 43 objects.*operator_catchup_closure_witness_append_only_update/i);
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);
  });

  it.each([
    ['processing', true, 'complete'],
    ['complete', false, 'echoed'],
  ] as const)('rejects a target without durable reply proof: status=%s echoed=%s', (
    status,
    echoed,
    expectedError,
  ) => {
    const fixture = installFixture(status, echoed);

    expect(() => closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://invalid-target',
    })).toThrow(expectedError);
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);
  });

  it('rejects a partial source set and a mismatched idempotent replay without partial inserts', () => {
    const fixture = installFixture('complete', true);
    expect(() => closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: [fixture.sourceSeqs[0]],
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://partial',
    })).toThrow('exactly match');
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);

    closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://first',
    });
    const later = Number(db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES ('later-catchup', ?, 'closure@g.us', 'complete', datetime('now'))
    `).run(fixture.conversationKey).lastInsertRowid);
    expect(() => closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: later,
      actor: 'operator:test',
      evidenceRef: 'test://mismatch',
    })).toThrow('different catch-up');
    expect(linkRows('superseded_by_operator_catchup')).toHaveLength(2);
  });

  it.each([
    ['cross-conversation', "UPDATE outbound_ops SET conversation_key = 'other-conversation' WHERE id = ?"],
    ['cross-chat', "UPDATE outbound_ops SET chat_jid = 'other@g.us' WHERE id = ?"],
    ['cross-source', 'UPDATE outbound_ops SET source_inbound_seq = source_inbound_seq + 1000 WHERE id = ?'],
    ['non-terminal', 'UPDATE outbound_ops SET is_terminal = 0 WHERE id = ?'],
  ] as const)('rejects delivery proof borrowed from a %s selected outbound', (_case, sql) => {
    const fixture = installFixture('complete', true);
    db.raw.prepare(sql).run(fixture.opId);

    expect(() => closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://mismatched-selected',
    })).toThrow('echoed delivery proof');
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);
  });

  it('treats a different later echoed payload as replay-blocking corroboration, not closure proof', () => {
    const fixture = installFixture('complete', false);
    db.raw.prepare(`
      UPDATE turn_terminal_records
      SET delivery_kind = 'delivery_unknown'
      WHERE id = ?
    `).run(fixture.terminalRecordId);
    const laterOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy, echoed_at
      ) VALUES (?, 'closure@g.us', 'text', '{"text":"DIFFERENT"}', 'echoed',
                ?, 0, 'unsafe', datetime('now'))
    `).run(fixture.conversationKey, fixture.catchupSeq).lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'system:test')
    `).run(fixture.terminalRecordId, laterOpId);

    expect(db.raw.prepare(`
      SELECT evidence_basis
      FROM operator_catchup_delivery_proof_candidates
      WHERE target_seq = ?
    `).get(fixture.catchupSeq)).toEqual({ evidence_basis: 'selected_corroborated' });
    expect(() => closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://corroboration-is-not-delivery-proof',
    })).toThrow('echoed delivery proof');
    expect(linkRows('superseded_by_operator_catchup')).toEqual([]);
  });

  it.each([
    ['actor', 'operator:other', 'test://echoed-ack'],
    ['evidence', 'operator:test', 'test://different-evidence'],
  ] as const)('rejects an idempotent replay with changed %s', (_case, actor, evidenceRef) => {
    const fixture = installFixture('complete', true);
    closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor: 'operator:test',
      evidenceRef: 'test://echoed-ack',
    });

    expect(() => closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      actor,
      evidenceRef,
    })).toThrow('different catch-up or evidence');
  });

  function installFixture(
    targetStatus: 'processing' | 'complete',
    targetEchoed: boolean,
  ): {
    planId: string;
    conversationKey: string;
    sourceSeqs: number[];
    catchupSeq: number;
    terminalRecordId: number;
    opId: number;
  } {
    const planId = 'pcr-test-closure';
    const conversationKey = 'closure-conversation';
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'pre_connect_recovery', 'system:test', 'fixture', 'test://fixture')
    `).run(planId);
    const sourceSeqs = ['source-one', 'source-two'].map((messageId) => Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason, failure_class
      ) VALUES (?, ?, 'closure@g.us', 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(messageId, conversationKey).lastInsertRowid));
    const insertPending = db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'crash recovery', 'test://fixture', 'system:test')
    `);
    for (const seq of sourceSeqs) insertPending.run(seq, planId);

    const targetResult = db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason
      ) VALUES ('catchup', ?, 'closure@g.us', ?,
                CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END,
                CASE WHEN ? = 'complete' THEN 'response_sent' ELSE NULL END)
    `).run(conversationKey, targetStatus, targetStatus, targetStatus);
    const catchupSeq = Number(targetResult.lastInsertRowid);
    const opId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
        is_terminal, replay_policy, echoed_at
      ) VALUES (?, 'closure@g.us', 'text', '{"text":"ACK"}', ?, ?, 1, 'unsafe',
                CASE WHEN ? = 'echoed' THEN datetime('now') ELSE NULL END)
    `).run(
      conversationKey,
      targetEchoed ? 'echoed' : 'submitted',
      catchupSeq,
      targetEchoed ? 'echoed' : 'submitted',
    ).lastInsertRowid);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, 'closure@g.us', ?, ?, 'catchup-turn',
                'catchup-manager', 1, 'replied', 'finalized_replied',
                ?, ?, ?)
    `).run(
      conversationKey,
      catchupSeq,
      catchupSeq,
      targetEchoed ? 'echoed' : 'enqueued',
      opId,
      targetEchoed ? 1 : 0,
    ).lastInsertRowid);
    return { planId, conversationKey, sourceSeqs, catchupSeq, terminalRecordId, opId };
  }

  function linkRows(disposition: string): Array<{ inbound_seq: number; superseded_by_seq: number | null }> {
    return db.raw.prepare(`
      SELECT inbound_seq, superseded_by_seq
      FROM inbound_disposition_links
      WHERE disposition = ?
      ORDER BY inbound_seq
    `).all(disposition) as Array<{ inbound_seq: number; superseded_by_seq: number | null }>;
  }
});
