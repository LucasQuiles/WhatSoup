import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, CURRENT_SCHEMA_MIGRATION } from '../../src/core/database.ts';
import { runMigration43 } from '../../src/core/database-migration-43.ts';
import { closeOperatorCatchupRecovery } from '../../src/core/recovery-catchup-closure.ts';

type CompletionKind = 'echo' | 'worker';
type SelectedStatus = 'echoed' | 'failed_permanent';

interface EchoTransferOptions {
  completionKind?: CompletionKind;
  completionProofId?: string;
  jobOwnerLogicalTurnId?: string;
  jobSourceLogicalTurnId?: string;
  omitCompletedJobProof?: boolean;
  proofChatJid?: string;
  proofConversationKey?: string;
  selectedIsTerminal?: 0 | 1;
  selectedStatus?: SelectedStatus;
  useDifferentProofSource?: boolean;
}

interface EchoTransferFixture {
  planId: string;
  conversationKey: string;
  sourceSeq: number;
  targetSeq: number;
  terminalRecordId: number;
  selectedOpId: number;
  recoveryJobId: number;
}

describe('migration 43 operator catch-up echo-recovery proof', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('installs schema 42 with shared admission proof and persisted witness enforcement', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(44);
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'view' AND name = 'operator_catchup_delivery_proofs'
    `).get()).toEqual({ name: 'operator_catchup_delivery_proofs' });

    const validation = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'inbound_disposition_closure_validate_insert'
    `).get() as { sql: string } | undefined;
    expect(validation?.sql).toContain('operator_catchup_delivery_proofs');

    const materialize = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'operator_catchup_closure_materialize_witness'
    `).get() as { sql: string } | undefined;
    expect(materialize?.sql).toContain('operator_catchup_delivery_proofs');

    for (const trigger of [
      'operator_catchup_terminal_proof_immutable',
      'operator_catchup_terminal_proof_retain',
      'operator_catchup_selected_outbound_proof_immutable',
      'operator_catchup_selected_outbound_proof_retain',
      'operator_catchup_recovery_job_proof_immutable',
      'operator_catchup_recovery_job_proof_retain',
    ]) {
      const row = db.raw.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
      `).get(trigger) as { sql: string } | undefined;
      expect(row?.sql).toContain('operator_catchup_closure_witnesses');
    }

    for (const index of [
      'idx_operator_catchup_witness_terminal',
      'idx_operator_catchup_witness_selected_op',
      'idx_operator_catchup_witness_recovery_job',
    ]) {
      expect(db.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?
      `).get(index)).toEqual({ name: index });
    }

    for (const [column, index] of [
      ['terminal_record_id', 'idx_operator_catchup_witness_terminal'],
      ['selected_op_id', 'idx_operator_catchup_witness_selected_op'],
      ['recovery_job_id', 'idx_operator_catchup_witness_recovery_job'],
    ]) {
      const plan = db.raw.prepare(`
        EXPLAIN QUERY PLAN
        SELECT 1 FROM operator_catchup_closure_witnesses WHERE ${column} = ?
      `).all(1) as Array<{ detail: string }>;
      expect(plan.map((step) => step.detail).join('\n')).toContain(index);
    }
  });

  it('fails closed instead of recording schema 42 against a partial database', () => {
    const partial = new DatabaseSync(':memory:');
    try {
      expect(() => runMigration43(partial)).toThrow(
        'migration 43 missing required tables: inbound_events, outbound_ops, '
          + 'turn_terminal_records, turn_recovery_jobs, recovery_plans, '
          + 'inbound_disposition_links, turn_delivery_corroboration',
      );
    } finally {
      partial.close();
    }
  });

  it('closes against a completed echo-recovery transfer without rewriting terminal delivery kind', () => {
    const fixture = installEchoTransferFixture();

    const receipt = closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: [fixture.sourceSeq],
      catchupSeq: fixture.targetSeq,
      actor: 'operator:test',
      evidenceRef: 'test://echo-recovery',
    });

    expect(receipt).toMatchObject({
      evidenceBasis: 'selected_echoed_recovery',
      terminalRecordId: fixture.terminalRecordId,
      selectedOpId: fixture.selectedOpId,
      recoveryJobId: fixture.recoveryJobId,
      completionProofId: `outbound-op:${fixture.selectedOpId}`,
      inserted: 1,
      openAfter: 0,
    });
    expect(db.raw.prepare(`
      SELECT delivery_kind FROM turn_terminal_records WHERE id = ?
    `).get(fixture.terminalRecordId)).toEqual({ delivery_kind: 'flushed' });
  });

  it('accepts the captured 47707/op103700/job204 equal-second settlement shape', () => {
    const planId = 'plan-live-47707-proof';
    const conversationKey = 'conversation-live-47707-proof';
    const chatJid = 'live-proof@g.us';
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', 'test', 'captured live proof shape')
    `).run(planId);
    db.raw.prepare(`
      INSERT INTO inbound_events (
        seq, message_id, conversation_key, chat_jid, processing_status,
        received_at, completed_at, terminal_reason, failure_class
      ) VALUES (47706, 'live-proof-source', ?, ?, 'failed',
                '2026-07-13 05:21:08', '2026-07-13 05:21:09',
                'error', 'crash_recovery')
    `).run(conversationKey, chatJid);
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, actor
      ) VALUES (47706, ?, 'recovery_pending_operator_catchup', NULL,
                'pending captured catch-up', 'test')
    `).run(planId);
    db.raw.prepare(`
      INSERT INTO inbound_events (
        seq, message_id, conversation_key, chat_jid, processing_status,
        received_at, completed_at, terminal_reason
      ) VALUES (47707, 'live-proof-target', ?, ?, 'complete',
                '2026-07-13 05:21:09', '2026-07-13 05:25:18', 'response_echoed')
    `).run(conversationKey, chatJid);
    db.raw.prepare(`
      INSERT INTO outbound_ops (
        id, conversation_key, chat_jid, op_type, payload, status,
        created_at, submitted_at, wa_message_id, source_inbound_seq,
        is_terminal, replay_policy
      ) VALUES (103700, ?, ?, 'text', '{"text":"ACK"}', 'submitted',
                '2026-07-13 05:25:17', '2026-07-13 05:25:18',
                'wa-live-proof-103700', 47707, 1, 'unsafe')
    `).run(conversationKey, chatJid);
    db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        id, scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed, created_at
      ) VALUES (300, 'per_chat', ?, ?, 47707, 47707,
                'live-source-turn', 'live-source-manager', 1, 'replied',
                'transferred_to_recovery_owner', 'flushed', 103700,
                'live-owner-turn', 'live-owner-manager', 1, 0,
                '2026-07-13 05:25:17')
    `).run(conversationKey, chatJid);
    db.raw.prepare(`
      UPDATE outbound_ops
      SET status = 'echoed', echoed_at = '2026-07-13 05:25:18'
      WHERE id = 103700
    `).run();
    db.raw.prepare(`
      INSERT INTO turn_recovery_jobs (
        id, terminal_record_id, scope, conversation_key, delivery_jid,
        source_inbound_seq, source_inbound_seq_key,
        source_logical_turn_id, source_manager_id, source_generation, source_message_id,
        owner_logical_turn_id, owner_manager_id, owner_generation,
        assigned_owner_logical_turn_id, assigned_owner_manager_id,
        assigned_owner_generation, replay_safe, sender_jid, replay_text,
        is_group, group_name, state, attempt_count, claim_epoch, claim_token,
        claim_expires_at, claimed_at, completed_at, completion_kind,
        completion_proof_id, created_at
      ) VALUES (204, 300, 'per_chat', ?, ?, 47707, 47707,
                'live-source-turn', 'live-source-manager', 1, 'live-proof-target',
                'live-owner-turn', 'live-owner-manager', 1,
                'live-owner-turn', 'live-owner-manager', 1,
                1, 'sender@test', 'captured reply', 1, 'DGX SPARK',
                'completed', 1, 1, 'echo-delivery:103700',
                '2026-07-13 05:30:18', '2026-07-13 05:25:18',
                '2026-07-13 05:25:18', 'echo', 'outbound-op:103700',
                '2026-07-13 05:25:17')
    `).run(conversationKey, chatJid);

    expect(closeOperatorCatchupRecovery(db, {
      planId,
      conversationKey,
      expectedSourceSeqs: [47706],
      catchupSeq: 47707,
      actor: 'operator:test',
      evidenceRef: 'test://captured-live-proof',
    })).toMatchObject({
      catchupSeq: 47707,
      evidenceBasis: 'selected_echoed_recovery',
      selectedOpId: 103700,
      recoveryJobId: 204,
      completionProofId: 'outbound-op:103700',
      inserted: 1,
    });
  });

  it.each([
    ['target terminal reason is not response_echoed', (fixture: EchoTransferFixture) => {
      db.raw.prepare("UPDATE inbound_events SET terminal_reason = 'response_sent' WHERE seq = ?")
        .run(fixture.targetSeq);
    }],
    ['recovery has an echo conflict', (fixture: EchoTransferFixture) => {
      db.raw.prepare(`
        UPDATE turn_recovery_jobs
        SET echo_conflict_at = datetime('now'), echo_conflict_reason = 'test-conflict'
        WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['selected delivery has no submitted timestamp', (fixture: EchoTransferFixture) => {
      db.raw.prepare('UPDATE outbound_ops SET submitted_at = NULL WHERE id = ?')
        .run(fixture.selectedOpId);
    }],
    ['selected delivery has no echoed timestamp', (fixture: EchoTransferFixture) => {
      db.raw.prepare('UPDATE outbound_ops SET echoed_at = NULL WHERE id = ?')
        .run(fixture.selectedOpId);
    }],
    ['selected delivery has no WhatsApp message id', (fixture: EchoTransferFixture) => {
      db.raw.prepare('UPDATE outbound_ops SET wa_message_id = NULL WHERE id = ?')
        .run(fixture.selectedOpId);
    }],
    ['selected delivery has a blank WhatsApp message id', (fixture: EchoTransferFixture) => {
      db.raw.prepare("UPDATE outbound_ops SET wa_message_id = '   ' WHERE id = ?")
        .run(fixture.selectedOpId);
    }],
    ['selected delivery has an NBSP-only WhatsApp message id', (
      fixture: EchoTransferFixture,
    ) => {
      db.raw.prepare('UPDATE outbound_ops SET wa_message_id = ? WHERE id = ?')
        .run('\u00a0', fixture.selectedOpId);
    }],
    ['echo completion has an incoherent claim token', (fixture: EchoTransferFixture) => {
      db.raw.prepare("UPDATE turn_recovery_jobs SET claim_token = 'echo-delivery:wrong' WHERE id = ?")
        .run(fixture.recoveryJobId);
    }],
    ['target receipt follows selected-op creation', (fixture: EchoTransferFixture) => {
      allowHistoricalTimelineCorruptionForProofTest();
      db.raw.prepare(`
        UPDATE inbound_events
        SET received_at = '2030-01-01 00:00:02', completed_at = '2030-01-01 00:00:06'
        WHERE seq = ?
      `).run(fixture.targetSeq);
      db.raw.prepare(`
        UPDATE outbound_ops
        SET created_at = '2030-01-01 00:00:01',
            submitted_at = '2030-01-01 00:00:03',
            echoed_at = '2030-01-01 00:00:04'
        WHERE id = ?
      `).run(fixture.selectedOpId);
      db.raw.prepare(`
        UPDATE turn_terminal_records SET created_at = '2030-01-01 00:00:02' WHERE id = ?
      `).run(fixture.terminalRecordId);
      db.raw.prepare(`
        UPDATE turn_recovery_jobs
        SET created_at = '2030-01-01 00:00:02',
            claimed_at = '2030-01-01 00:00:05',
            completed_at = '2030-01-01 00:00:07'
        WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['recovery claim predates recovery creation', (fixture: EchoTransferFixture) => {
      allowHistoricalTimelineCorruptionForProofTest();
      db.raw.prepare(`
        UPDATE turn_recovery_jobs
        SET created_at = '2030-01-01 00:00:02',
            claimed_at = '2030-01-01 00:00:01',
            completed_at = '2030-01-01 00:00:03'
        WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['recovery claim expiry is malformed', (fixture: EchoTransferFixture) => {
      db.raw.prepare(`
        UPDATE turn_recovery_jobs SET claim_expires_at = 'not-a-timestamp' WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['recovery completion occurs after claim expiry', (fixture: EchoTransferFixture) => {
      db.raw.prepare(`
        UPDATE turn_recovery_jobs SET claim_expires_at = '2000-01-01 00:00:00' WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['terminal creation timestamp is malformed', (fixture: EchoTransferFixture) => {
      allowHistoricalTimelineCorruptionForProofTest();
      db.raw.prepare("UPDATE turn_terminal_records SET created_at = 'not-a-timestamp' WHERE id = ?")
        .run(fixture.terminalRecordId);
    }],
    ['terminal record is created after its recovery job', (fixture: EchoTransferFixture) => {
      allowHistoricalTimelineCorruptionForProofTest();
      db.raw.prepare(`
        UPDATE inbound_events SET completed_at = '2030-01-01 00:00:04' WHERE seq = ?
      `).run(fixture.targetSeq);
      db.raw.prepare(`
        UPDATE turn_terminal_records SET created_at = '2030-01-01 00:00:03' WHERE id = ?
      `).run(fixture.terminalRecordId);
      db.raw.prepare(`
        UPDATE turn_recovery_jobs
        SET created_at = '2030-01-01 00:00:02',
            claimed_at = '2030-01-01 00:00:04',
            completed_at = '2030-01-01 00:00:05'
        WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['recovery job is created after target completion', (fixture: EchoTransferFixture) => {
      allowHistoricalTimelineCorruptionForProofTest();
      db.raw.prepare(`
        UPDATE inbound_events SET completed_at = '2030-01-01 00:00:02' WHERE seq = ?
      `).run(fixture.targetSeq);
      db.raw.prepare(`
        UPDATE turn_recovery_jobs
        SET created_at = '2030-01-01 00:00:03',
            claimed_at = '2030-01-01 00:00:04',
            completed_at = '2030-01-01 00:00:05'
        WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['selected echo predates creation of the linked recovery job', (fixture: EchoTransferFixture) => {
      allowHistoricalTimelineCorruptionForProofTest();
      db.raw.prepare(`
        UPDATE inbound_events
        SET received_at = '2030-01-01 00:00:00', completed_at = '2030-01-01 00:00:05'
        WHERE seq = ?
      `).run(fixture.targetSeq);
      db.raw.prepare(`
        UPDATE outbound_ops
        SET created_at = '2030-01-01 00:00:00',
            submitted_at = '2030-01-01 00:00:01',
            echoed_at = '2030-01-01 00:00:03'
        WHERE id = ?
      `).run(fixture.selectedOpId);
      db.raw.prepare(`
        UPDATE turn_terminal_records SET created_at = '2030-01-01 00:00:02' WHERE id = ?
      `).run(fixture.terminalRecordId);
      db.raw.prepare(`
        UPDATE turn_recovery_jobs
        SET created_at = '2030-01-01 00:00:04',
            claimed_at = '2030-01-01 00:00:05',
            completed_at = '2030-01-01 00:00:06'
        WHERE id = ?
      `).run(fixture.recoveryJobId);
    }],
    ['submission occurs after the echo', (fixture: EchoTransferFixture) => {
      db.raw.prepare(`
        UPDATE outbound_ops
        SET submitted_at = '2030-01-01 00:00:01', echoed_at = '2030-01-01 00:00:00'
        WHERE id = ?
      `).run(fixture.selectedOpId);
    }],
    ['target completion predates the echo', (fixture: EchoTransferFixture) => {
      db.raw.prepare(`
        UPDATE outbound_ops SET echoed_at = '2030-01-01 00:00:00' WHERE id = ?
      `).run(fixture.selectedOpId);
    }],
    ['recovery completion predates the echo', (fixture: EchoTransferFixture) => {
      db.raw.prepare(`
        UPDATE outbound_ops SET echoed_at = '2030-01-01 00:00:00' WHERE id = ?
      `).run(fixture.selectedOpId);
      db.raw.prepare(`
        UPDATE inbound_events SET completed_at = '2030-01-01 00:00:00' WHERE seq = ?
      `).run(fixture.targetSeq);
    }],
  ] as Array<[string, (fixture: EchoTransferFixture) => void]>)('rejects transferred proof when %s', (
    _case,
    corrupt,
  ) => {
    const fixture = installEchoTransferFixture();
    corrupt(fixture);

    expect(() => insertClosure(fixture)).toThrow('invalid operator catch-up closure');
    expect(closureCount()).toBe(0);
  });

  it.each([
    ['job/terminal source identity mismatch', {
      jobSourceLogicalTurnId: 'different-source-turn',
    }],
    ['job conversation identity does not bind the target', {
      proofConversationKey: 'different-proof-conversation',
    }],
    ['job delivery JID does not bind the target', {
      proofChatJid: 'different-proof-chat@g.us',
    }],
    ['job source sequence does not bind the target', {
      useDifferentProofSource: true,
    }],
    ['terminal recovery owner does not bind the job owner', {
      jobOwnerLogicalTurnId: 'different-recovery-owner',
    }],
    ['job has no completed-at echo proof', {
      omitCompletedJobProof: true,
    }],
    ['worker completion', {
      completionKind: 'worker',
      completionProofId: 'worker:completed',
    }],
    ['mismatched echo completion proof', {
      completionProofId: 'outbound-op:999999',
    }],
    ['non-echo selected delivery', {
      selectedStatus: 'failed_permanent',
    }],
    ['nonterminal selected delivery', {
      selectedIsTerminal: 0,
    }],
  ] satisfies Array<[string, EchoTransferOptions]>)('rejects %s', (_case, options) => {
    const fixture = installEchoTransferFixture(options);

    expect(() => insertClosure(fixture)).toThrow('invalid operator catch-up closure');
    expect(closureCount()).toBe(0);
  });

  it('freezes and retains every echo-recovery proof anchor after closure', () => {
    const fixture = installEchoTransferFixture();
    insertClosure(fixture);

    expect(() => db.raw.prepare(`
      UPDATE turn_recovery_jobs
      SET completion_proof_id = 'outbound-op:rewritten'
      WHERE id = ?
    `).run(fixture.recoveryJobId))
      .toThrow('operator catch-up recovery job proof is immutable');
    expect(() => db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?')
      .run(fixture.recoveryJobId))
      .toThrow('operator catch-up recovery job proof must be retained');
    expect(() => db.raw.prepare(`
      UPDATE turn_terminal_records SET delivery_kind = 'delivery_unknown' WHERE id = ?
    `).run(fixture.terminalRecordId))
      .toThrow('operator catch-up terminal proof is immutable');
    expect(() => db.raw.prepare('DELETE FROM turn_terminal_records WHERE id = ?')
      .run(fixture.terminalRecordId))
      .toThrow('operator catch-up terminal proof must be retained');
    expect(() => db.raw.prepare(`
      UPDATE outbound_ops SET status = 'failed_permanent' WHERE id = ?
    `).run(fixture.selectedOpId))
      .toThrow('operator catch-up selected outbound proof is immutable');
    expect(() => db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?')
      .run(fixture.selectedOpId))
      .toThrow('operator catch-up selected outbound proof must be retained');
  });

  it('rejects an ambiguous target with multiple valid echo-recovery proofs', () => {
    const fixture = installEchoTransferFixture();
    installSecondEchoTransferProof(fixture);

    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM operator_catchup_delivery_proof_candidates
      WHERE target_seq = ?
    `).get(fixture.targetSeq)).toEqual({ count: 2 });
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM operator_catchup_delivery_proofs
      WHERE target_seq = ?
    `).get(fixture.targetSeq)).toEqual({ count: 0 });
    expect(() => insertClosure(fixture)).toThrow('invalid operator catch-up closure');
  });

  it('cannot thaw a closed proof by appending a second valid candidate', () => {
    const fixture = installEchoTransferFixture();
    insertClosure(fixture);
    installSecondEchoTransferProof(fixture);

    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM operator_catchup_delivery_proofs
      WHERE target_seq = ?
    `).get(fixture.targetSeq)).toEqual({ count: 0 });
    expect(() => db.raw.prepare(`
      UPDATE turn_recovery_jobs SET completion_proof_id = 'outbound-op:rewritten'
      WHERE id = ?
    `).run(fixture.recoveryJobId))
      .toThrow('operator catch-up recovery job proof is immutable');
    expect(() => db.raw.prepare(`
      UPDATE outbound_ops SET status = 'failed_permanent' WHERE id = ?
    `).run(fixture.selectedOpId))
      .toThrow('operator catch-up selected outbound proof is immutable');
  });

  it('seals a witnessed plan and conversation against later pending links', () => {
    const fixture = installEchoTransferFixture();
    insertClosure(fixture);
    const laterSource = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES (?, ?, 'closure-42@g.us', 'failed', datetime('now'),
                'error', 'crash_recovery')
    `).run(
      `late-source-${Math.random()}`,
      fixture.conversationKey,
    ).lastInsertRowid);

    expect(() => db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'late pending catch-up', 'test://late-pending', 'test')
    `).run(laterSource, fixture.planId))
      .toThrow('operator catch-up recovery group is already closed');
  });

  it.each([
    ['actor', ' test ', 'test://direct-closure'],
    ['evidence reference', 'test', ' test://direct-closure '],
    ['TAB-suffixed actor', 'test\t', 'test://direct-closure'],
    ['NBSP-prefixed evidence reference', 'test', '\u00a0test://direct-closure'],
  ])('rejects a raw closure with noncanonical %s bytes', (_field, actor, evidenceRef) => {
    const fixture = installEchoTransferFixture();

    expect(() => db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'operator catch-up completed with echoed reply', ?, ?)
    `).run(
      fixture.sourceSeq,
      fixture.planId,
      fixture.targetSeq,
      evidenceRef,
      actor,
    )).toThrow('invalid operator catch-up closure');
    expect(closureCount()).toBe(0);
  });

  it('replays from the persisted witness after a later candidate makes the live proof ambiguous', () => {
    const fixture = installEchoTransferFixture();
    const params = {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: [fixture.sourceSeq],
      catchupSeq: fixture.targetSeq,
      actor: 'operator:test',
      evidenceRef: 'test://persisted-witness',
    };
    const first = closeOperatorCatchupRecovery(db, params);
    installSecondEchoTransferProof(fixture);

    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM operator_catchup_delivery_proofs
      WHERE target_seq = ?
    `).get(fixture.targetSeq)).toEqual({ count: 0 });
    expect(closeOperatorCatchupRecovery(db, params)).toEqual({
      ...first,
      inserted: 0,
      idempotent: true,
      openBefore: 0,
      openAfter: 0,
    });
  });

  it('persists an append-only reconstructable witness for the accepted proof', () => {
    const fixture = installEchoTransferFixture();
    closeOperatorCatchupRecovery(db, {
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      expectedSourceSeqs: [fixture.sourceSeq],
      catchupSeq: fixture.targetSeq,
      actor: 'operator:test',
      evidenceRef: 'test://durable-witness',
    });

    expect(db.raw.prepare(`
      SELECT recovery_plan_id, conversation_key, target_seq, actor, evidence_ref,
             evidence_basis, terminal_record_id, selected_op_id, recovery_job_id,
             completion_proof_id
      FROM operator_catchup_closure_witnesses
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).get(fixture.planId, fixture.conversationKey)).toEqual({
      recovery_plan_id: fixture.planId,
      conversation_key: fixture.conversationKey,
      target_seq: fixture.targetSeq,
      actor: 'operator:test',
      evidence_ref: 'test://durable-witness',
      evidence_basis: 'selected_echoed_recovery',
      terminal_record_id: fixture.terminalRecordId,
      selected_op_id: fixture.selectedOpId,
      recovery_job_id: fixture.recoveryJobId,
      completion_proof_id: `outbound-op:${fixture.selectedOpId}`,
    });
    expect(() => db.raw.prepare(`
      UPDATE operator_catchup_closure_witnesses SET evidence_ref = 'test://rewritten'
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).run(fixture.planId, fixture.conversationKey))
      .toThrow('operator catch-up closure witness is append-only');
    expect(() => db.raw.prepare(`
      DELETE FROM operator_catchup_closure_witnesses
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).run(fixture.planId, fixture.conversationKey))
      .toThrow('operator catch-up closure witness is append-only');
  });

  function installEchoTransferFixture(
    options: EchoTransferOptions = {},
  ): EchoTransferFixture {
    const planId = `plan-42-${Math.random()}`;
    const conversationKey = `conversation-42-${Math.random()}`;
    const chatJid = 'closure-42@g.us';
    const proofConversationKey = options.proofConversationKey ?? conversationKey;
    const proofChatJid = options.proofChatJid ?? chatJid;
    const sourceLogicalTurnId = 'catchup-source-turn';
    const sourceManagerId = 'catchup-source-manager';
    const sourceMessageId = `catchup-target-${Math.random()}`;
    const ownerLogicalTurnId = 'catchup-owner-turn';
    const ownerManagerId = 'catchup-owner-manager';

    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', 'test', 'migration 43 fixture')
    `).run(planId);
    const sourceSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(`catchup-source-${Math.random()}`, conversationKey, chatJid).lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'pending catch-up', 'test')
    `).run(sourceSeq, planId);

    const targetSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_echoed')
    `).run(sourceMessageId, conversationKey, chatJid).lastInsertRowid);
    const proofSourceMessageId = options.useDifferentProofSource
      ? `different-proof-source-${Math.random()}`
      : sourceMessageId;
    const proofSourceSeq = options.useDifferentProofSource
      ? Number(db.raw.prepare(`
          INSERT INTO inbound_events (
            message_id, conversation_key, chat_jid, processing_status,
            completed_at, terminal_reason
          ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_echoed')
        `).run(
          proofSourceMessageId,
          proofConversationKey,
          proofChatJid,
        ).lastInsertRowid)
      : targetSeq;
    const selectedOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy, submitted_at,
        echoed_at, wa_message_id
      ) VALUES (?, ?, 'text', '{"text":"ACK"}', ?, ?, ?, 'unsafe',
                datetime('now'),
                CASE WHEN ? = 'echoed' THEN datetime('now') ELSE NULL END,
                'wa-migration-42-proof')
    `).run(
      proofConversationKey,
      proofChatJid,
      'submitted',
      proofSourceSeq,
      options.selectedIsTerminal ?? 1,
      'submitted',
    ).lastInsertRowid);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, ?, 1, 'replied',
                'transferred_to_recovery_owner', 'flushed', ?, ?, ?, 1, 0)
    `).run(
      proofConversationKey,
      proofChatJid,
      proofSourceSeq,
      proofSourceSeq,
      sourceLogicalTurnId,
      sourceManagerId,
      selectedOpId,
      ownerLogicalTurnId,
      ownerManagerId,
    ).lastInsertRowid);

    const selectedStatus = options.selectedStatus ?? 'echoed';
    db.raw.prepare(`
      UPDATE outbound_ops
      SET status = ?,
          echoed_at = CASE WHEN ? = 'echoed' THEN datetime('now') ELSE NULL END
      WHERE id = ?
    `).run(selectedStatus, selectedStatus, selectedOpId);

    const completionKind = options.completionKind ?? 'echo';
    const completionProofId = options.completionProofId
      ?? `outbound-op:${selectedOpId}`;
    const recoveryJobId = Number((options.omitCompletedJobProof
      ? db.raw.prepare(`
          INSERT INTO turn_recovery_jobs (
            terminal_record_id, scope, conversation_key, delivery_jid,
            source_inbound_seq, source_inbound_seq_key,
            source_logical_turn_id, source_manager_id, source_generation, source_message_id,
            owner_logical_turn_id, owner_manager_id, owner_generation,
            assigned_owner_logical_turn_id, assigned_owner_manager_id,
            assigned_owner_generation, replay_safe, sender_jid, replay_text,
            is_group, group_name, state
          ) VALUES (?, 'per_chat', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, 1,
                    1, 'sender@test', 'catch-up', 1, 'DGX SPARK', 'pending')
        `).run(
          terminalRecordId,
          proofConversationKey,
          proofChatJid,
          proofSourceSeq,
          proofSourceSeq,
          options.jobSourceLogicalTurnId ?? sourceLogicalTurnId,
          sourceManagerId,
          proofSourceMessageId,
          options.jobOwnerLogicalTurnId ?? ownerLogicalTurnId,
          ownerManagerId,
          ownerLogicalTurnId,
          ownerManagerId,
        )
      : db.raw.prepare(`
      INSERT INTO turn_recovery_jobs (
        terminal_record_id, scope, conversation_key, delivery_jid,
        source_inbound_seq, source_inbound_seq_key,
        source_logical_turn_id, source_manager_id, source_generation, source_message_id,
        owner_logical_turn_id, owner_manager_id, owner_generation,
        assigned_owner_logical_turn_id, assigned_owner_manager_id,
        assigned_owner_generation, replay_safe, sender_jid, replay_text,
        is_group, group_name, state, attempt_count, claim_epoch, claim_token,
        claim_expires_at, claimed_at, completed_at, completion_kind,
        completion_proof_id
      ) VALUES (?, 'per_chat', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, 1,
                1, 'sender@test', 'catch-up', 1, 'DGX SPARK', 'completed',
                1, 1, ?, datetime('now', '+5 minutes'),
                datetime('now'), datetime('now'), ?, ?)
    `).run(
      terminalRecordId,
      proofConversationKey,
      proofChatJid,
      proofSourceSeq,
      proofSourceSeq,
      options.jobSourceLogicalTurnId ?? sourceLogicalTurnId,
      sourceManagerId,
      proofSourceMessageId,
      options.jobOwnerLogicalTurnId ?? ownerLogicalTurnId,
      ownerManagerId,
      ownerLogicalTurnId,
      ownerManagerId,
      `echo-delivery:${selectedOpId}`,
      completionKind,
      completionProofId,
    )).lastInsertRowid);
    return {
      planId,
      conversationKey,
      sourceSeq,
      targetSeq,
      terminalRecordId,
      selectedOpId,
      recoveryJobId,
    };
  }

  function allowHistoricalTimelineCorruptionForProofTest(): void {
    db.raw.exec(`
      DROP TRIGGER turn_terminal_recovery_envelope_immutable;
      DROP TRIGGER turn_recovery_immutable_envelope;
    `);
  }

  function insertClosure(fixture: EchoTransferFixture): void {
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'operator catch-up completed with echoed reply',
                'test://direct-closure', 'test')
    `).run(fixture.sourceSeq, fixture.planId, fixture.targetSeq);
  }

  function installSecondEchoTransferProof(fixture: EchoTransferFixture): void {
    const target = db.raw.prepare(`
      SELECT message_id, conversation_key, chat_jid
      FROM inbound_events WHERE seq = ?
    `).get(fixture.targetSeq) as {
      message_id: string;
      conversation_key: string;
      chat_jid: string;
    };
    const selectedOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy, submitted_at, wa_message_id
      ) VALUES (?, ?, 'text', '{"text":"second ACK"}', 'submitted', ?, 1, 'unsafe',
                datetime('now'), 'wa-second-migration-42-proof')
    `).run(target.conversation_key, target.chat_jid, fixture.targetSeq).lastInsertRowid);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, 'second-source-turn',
                'second-source-manager', 1, 'replied',
                'transferred_to_recovery_owner', 'flushed', ?,
                'second-owner-turn', 'second-owner-manager', 1, 0)
    `).run(
      target.conversation_key,
      target.chat_jid,
      fixture.targetSeq,
      fixture.targetSeq,
      selectedOpId,
    ).lastInsertRowid);
    db.raw.prepare(`
      UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?
    `).run(selectedOpId);
    db.raw.prepare(`
      INSERT INTO turn_recovery_jobs (
        terminal_record_id, scope, conversation_key, delivery_jid,
        source_inbound_seq, source_inbound_seq_key,
        source_logical_turn_id, source_manager_id, source_generation, source_message_id,
        owner_logical_turn_id, owner_manager_id, owner_generation,
        assigned_owner_logical_turn_id, assigned_owner_manager_id,
        assigned_owner_generation, replay_safe, sender_jid, replay_text,
        is_group, group_name, state, attempt_count, claim_epoch, claim_token,
        claim_expires_at, claimed_at, completed_at, completion_kind,
        completion_proof_id
      ) VALUES (?, 'per_chat', ?, ?, ?, ?, 'second-source-turn',
                'second-source-manager', 1, ?, 'second-owner-turn',
                'second-owner-manager', 1, 'second-owner-turn',
                'second-owner-manager', 1, 1, 'sender@test', 'second catch-up',
                1, 'DGX SPARK', 'completed', 1, 1, ?,
                datetime('now', '+5 minutes'), datetime('now'), datetime('now'),
                'echo', ?)
    `).run(
      terminalRecordId,
      target.conversation_key,
      target.chat_jid,
      fixture.targetSeq,
      fixture.targetSeq,
      target.message_id,
      `echo-delivery:${selectedOpId}`,
      `outbound-op:${selectedOpId}`,
    );
  }

  function closureCount(): number {
    return Number((db.raw.prepare(`
      SELECT COUNT(*) AS count FROM inbound_disposition_links
      WHERE disposition = 'superseded_by_operator_catchup'
    `).get() as { count: number }).count);
  }
});
