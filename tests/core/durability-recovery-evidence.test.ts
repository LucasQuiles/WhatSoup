import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { runMigration45 } from '../../src/core/database-migration-45.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  createRecoveryStats,
  DurabilityRecoveryEvidence,
} from '../../src/core/durability-recovery-evidence.ts';
import { ReplyGuaranteeManager } from '../../src/core/reply-guarantee.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => true));
const clearAlertSource = vi.hoisted(() => vi.fn(() => true));
const gateQuarantineClear = vi.hoisted(() => vi.fn(() => ({ action: 'clear' })));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked: emitAlert,
  clearAlertSource,
  clearAlertSourceChecked: clearAlertSource,
}));

vi.mock('../../src/lib/fleet-health-gate.ts', () => ({ gateQuarantineClear }));

const INCIDENT_INBOUND_SEQ = 47_645;
const INCIDENT_SELECTED_OP_ID = 103_541;
const INCIDENT_ECHOED_OP_IDS = [103_542, 103_543, 103_544, 103_545, 103_548, 103_551, 103_552];
const CONVERSATION_KEY = 'recovery-proof-group';
const DELIVERY_JID = 'recovery-proof-group@g.us';

function rowJson(db: Database, table: string, idColumn: string, id: number): string {
  return JSON.stringify(db.raw.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id));
}

describe('durable recovery evidence ordering', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
    gateQuarantineClear.mockClear();
  });

  afterEach(() => db.close());

  it.each([
    ['plan', 'recovery_plans'],
    ['run', 'recovery_runs'],
  ] as const)('fails closed when the recovery %s receipt cannot start', (_kind, table) => {
    const opId = engine.createOutboundOp({
      conversationKey: 'order-key',
      chatJid: 'order-jid',
      opType: 'text',
      payload: '{"text":"in flight"}',
      replayPolicy: 'unsafe',
    });
    engine.markSending(opId);
    db.raw.exec(`
      CREATE TRIGGER deny_recovery_receipt
      BEFORE INSERT ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'recovery receipt denied');
      END
    `);

    expect(() => engine.preConnectRecovery()).toThrow('recovery receipt denied');
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ status: 'sending' });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_plans').get())
      .toEqual({ count: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_runs').get())
      .toEqual({ count: 0 });
  });

  it('atomically records continuity, failure, and pending catch-up under the started plan', () => {
    const seq = engine.journalInbound('pending-catchup', 'catchup-key', 'catchup-jid', 'agent');

    const stats = engine.preConnectRecovery();

    expect(stats.recoveryPlanId).toEqual(expect.any(String));
    expect(stats.recoveryRunId).toEqual(expect.any(Number));
    expect(stats.openRecoveries).toBe(1);
    expect(db.raw.prepare(`
      SELECT processing_status, terminal_reason, failure_class,
             continuity_candidate_reason, continuity_candidate_source
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'failed',
      terminal_reason: 'error',
      failure_class: 'crash_recovery',
      continuity_candidate_reason: 'crash_reclaim_no_terminal_outbound',
      continuity_candidate_source: 'pre_connect_recovery',
    });
    expect(db.raw.prepare(`
      SELECT inbound_seq, recovery_plan_id, disposition, superseded_by_seq, actor
      FROM inbound_disposition_links
    `).get()).toEqual({
      inbound_seq: seq,
      recovery_plan_id: stats.recoveryPlanId,
      disposition: 'recovery_pending_operator_catchup',
      superseded_by_seq: null,
      actor: 'durability_engine',
    });
    const recoveryRunId = stats.recoveryRunId;
    expect(recoveryRunId).toEqual(expect.any(Number));
    if (recoveryRunId == null) throw new Error('Expected a durable recovery run identity');
    expect(db.raw.prepare(`
      SELECT id, recovery_plan_id, completed_at
      FROM recovery_runs WHERE id = ?
    `).get(recoveryRunId)).toEqual({
      id: recoveryRunId,
      recovery_plan_id: stats.recoveryPlanId,
      completed_at: expect.any(String),
    });
    expect(engine.getHealthStats().openRecoveries).toBe(1);
  });

  it('rolls back continuity and failure when the pending link cannot be inserted', () => {
    const seq = engine.journalInbound('pending-link-denied', 'catchup-key', 'catchup-jid', 'agent');
    db.raw.exec(`
      CREATE TRIGGER deny_pending_link
      BEFORE INSERT ON inbound_disposition_links
      BEGIN
        SELECT RAISE(ABORT, 'pending link denied');
      END
    `);

    expect(() => engine.preConnectRecovery()).toThrow('pending link denied');
    expect(db.raw.prepare(`
      SELECT processing_status, terminal_reason, failure_class,
             continuity_candidate_reason, continuity_candidate_source
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'processing',
      terminal_reason: null,
      failure_class: null,
      continuity_candidate_reason: null,
      continuity_candidate_source: null,
    });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM inbound_disposition_links').get())
      .toEqual({ count: 0 });
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'pre_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['record_pending_operator_catchup'],
      openRecoveries: null,
    });
  });

  it('leaves pre-connect recovery incomplete and fails closed after an isolated mutation failure', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'pre-connect-incomplete',
      chatJid: 'pre-connect-incomplete-jid',
      opType: 'text',
      payload: '{"text":"in flight"}',
      replayPolicy: 'unsafe',
    });
    engine.markSending(opId);
    db.raw.exec(`
      CREATE TRIGGER deny_pre_connect_promotion
      BEFORE UPDATE OF status ON outbound_ops
      WHEN OLD.status = 'sending' AND NEW.status = 'maybe_sent'
      BEGIN
        SELECT RAISE(ABORT, 'pre-connect promotion denied');
      END
    `);

    expect(() => engine.preConnectRecovery()).toThrow('pre-connect promotion denied');
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ status: 'sending' });
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'pre_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['promote_sending_outbound'],
      openRecoveries: 0,
    });
    expect(engine.getHealthStats().lastRecoveryAt).toBeNull();
  });

  it('preserves the primary phase failure when incomplete-receipt persistence also fails', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'pre-connect-double-failure',
      chatJid: 'pre-connect-double-failure-jid',
      opType: 'text',
      payload: '{"text":"in flight"}',
      replayPolicy: 'unsafe',
    });
    engine.markSending(opId);
    db.raw.exec(`
      CREATE TRIGGER deny_primary_recovery_mutation
      BEFORE UPDATE OF status ON outbound_ops
      WHEN OLD.status = 'sending' AND NEW.status = 'maybe_sent'
      BEGIN
        SELECT RAISE(ABORT, 'primary recovery mutation denied');
      END;
      CREATE TRIGGER deny_incomplete_receipt
      BEFORE UPDATE ON recovery_runs
      WHEN OLD.completed_at IS NULL AND NEW.completed_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'incomplete receipt denied');
      END;
    `);

    let thrown: unknown;
    try {
      engine.preConnectRecovery();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error('Expected recovery and receipt failures to retain both causes');
    }
    expect(thrown.errors.map((err: unknown) => (
      err instanceof Error ? err.message : String(err)
    ))).toEqual([
      'primary recovery mutation denied',
      'incomplete receipt denied',
    ]);
    expect(db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'pre_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get()).toEqual({ completed_at: null, notes: null });
  });

  it('leaves post-connect recovery incomplete and never clears quarantine after a mutation failure', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'post-connect-incomplete',
      chatJid: 'post-connect-incomplete-jid',
      opType: 'text',
      payload: '{"text":"maybe sent"}',
      replayPolicy: 'safe',
    });
    engine.markMaybeSent(opId, 'crash-in-flight');
    db.raw.exec(`
      CREATE TRIGGER deny_post_connect_reconciliation
      BEFORE UPDATE OF status ON outbound_ops
      WHEN OLD.status = 'maybe_sent' AND NEW.status = 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'post-connect reconciliation denied');
      END
    `);

    expect(() => engine.postConnectRecovery()).toThrow('post-connect reconciliation denied');
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ status: 'maybe_sent' });
    expect(gateQuarantineClear).not.toHaveBeenCalled();
    expect(clearAlertSource).not.toHaveBeenCalled();
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['reconcile_maybe_sent_outbound'],
      openRecoveries: 0,
    });
    expect(engine.getHealthStats().lastRecoveryAt).toBeNull();
  });

  it.each([
    ['pre_connect', () => engine.preConnectRecovery()],
    ['post_connect', () => engine.postConnectRecovery()],
  ] as const)('records %s recovery as incomplete when the open-recovery count fails', (
    trigger,
    recover,
  ) => {
    db.raw.exec('DROP TABLE inbound_disposition_links');

    expect(recover).toThrow('no such table: inbound_disposition_links');
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(trigger) as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['count_open_recoveries'],
      openRecoveries: null,
    });
    expect(gateQuarantineClear).not.toHaveBeenCalled();
  });

  it.each([
    ['pre_connect', () => engine.preConnectRecovery()],
    ['post_connect', () => engine.postConnectRecovery()],
  ] as const)('records %s finalization failure as incomplete', (trigger, recover) => {
    db.raw.exec(`
      CREATE TRIGGER deny_recovery_finalization
      BEFORE UPDATE OF completed_at ON recovery_runs
      WHEN OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'recovery finalization denied');
      END
    `);

    expect(recover).toThrow('recovery finalization denied');
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(trigger) as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['finalize_recovery_run'],
      openRecoveries: 0,
    });
  });

  it('starts the sweep plan/run before terminalization and uses its outer transaction', () => {
    const seq = engine.journalInbound('stale-catchup', 'stale-key', 'stale-jid', 'agent');
    db.raw.prepare(
      "UPDATE inbound_events SET received_at = datetime('now', '-25 hours') WHERE seq = ?",
    ).run(seq);
    db.raw.exec(`
      CREATE TABLE recovery_order_audit (plans INTEGER NOT NULL, runs INTEGER NOT NULL);
      CREATE TRIGGER audit_recovery_order
      BEFORE UPDATE OF processing_status ON inbound_events
      WHEN OLD.processing_status = 'processing' AND NEW.processing_status = 'failed'
      BEGIN
        INSERT INTO recovery_order_audit (plans, runs)
        SELECT
          (SELECT COUNT(*) FROM recovery_plans),
          (SELECT COUNT(*) FROM recovery_runs WHERE completed_at IS NULL);
      END;
    `);

    expect(engine.sweepStuckInbound()).toEqual({
      completedEchoed: 0,
      completedTurnDone: 0,
      failedStale: 1,
      reclaimedRecoveryOwned: 0,
    });
    expect(db.raw.prepare('SELECT plans, runs FROM recovery_order_audit').get())
      .toEqual({ plans: 1, runs: 1 });
    expect(db.raw.prepare(`
      SELECT inbound_seq, disposition FROM inbound_disposition_links WHERE inbound_seq = ?
    `).get(seq)).toEqual({
      inbound_seq: seq,
      disposition: 'recovery_pending_operator_catchup',
    });
    expect(engine.getHealthStats().openRecoveries).toBe(1);
  });

  function seedIncident(): { terminalRecordId: number; recoveryJobId: number } {
    db.raw.prepare(`
      INSERT INTO inbound_events (
        seq, message_id, conversation_key, chat_jid, routed_to, processing_status
      ) VALUES (?, 'incident-source', ?, ?, 'agent', 'processing')
    `).run(INCIDENT_INBOUND_SEQ, CONVERSATION_KEY, DELIVERY_JID);
    db.raw.prepare(`
      INSERT INTO outbound_ops (
        id, conversation_key, chat_jid, op_type, payload, payload_hash, status,
        source_inbound_seq, is_terminal, replay_policy, error
      ) VALUES (?, ?, ?, 'text', '{"text":"selected"}', 'selected-hash',
        'maybe_sent', ?, 0, 'unsafe', 'delivery-unknown')
    `).run(INCIDENT_SELECTED_OP_ID, CONVERSATION_KEY, DELIVERY_JID, INCIDENT_INBOUND_SEQ);

    const owner: RecoveryOwnerIdentity = {
      logicalTurnId: 'operator-catchup',
      managerId: 'operator-manager',
      generation: 2,
    };
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq: INCIDENT_INBOUND_SEQ,
        logicalTurnId: 'incident-turn',
        managerId: 'incident-manager',
        generation: 1,
      },
      attemptOutcome: { kind: 'failed', class: 'unknown_terminal' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'delivery_unknown', opId: INCIDENT_SELECTED_OP_ID },
    };
    const receipt = engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, {
        sourceMessageId: 'incident-source',
        replaySafe: false,
        senderJid: '15550100000@s.whatsapp.net',
        senderName: 'Operator',
        text: 'preserved incident source body',
        isGroup: true,
        groupName: 'hardware-lab',
      }),
    });

    for (const id of INCIDENT_ECHOED_OP_IDS) {
      db.raw.prepare(`
        INSERT INTO outbound_ops (
          id, conversation_key, chat_jid, op_type, payload, payload_hash, status,
          echoed_at, wa_message_id, source_inbound_seq, is_terminal, replay_policy
        ) VALUES (?, ?, ?, 'text', ?, ?, 'echoed', datetime('now'), ?, ?, 0, 'unsafe')
      `).run(
        id,
        CONVERSATION_KEY,
        DELIVERY_JID,
        JSON.stringify({ text: `later-${id}` }),
        `hash-${id}`,
        `wa-${id}`,
        INCIDENT_INBOUND_SEQ,
      );
    }
    return {
      terminalRecordId: receipt.recordId,
      recoveryJobId: receipt.recoveryJob!.jobId,
    };
  }

  it('records post-connect corroboration failure as incomplete before outbound recovery', () => {
    seedIncident();
    db.raw.exec('DROP TABLE turn_delivery_corroboration');

    expect(() => engine.postConnectRecovery()).toThrow('no such table: turn_delivery_corroboration');
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['reconcile_turn_delivery_corroboration'],
      openRecoveries: null,
    });
    expect(gateQuarantineClear).not.toHaveBeenCalled();
  });

  const reconciliationMismatches: ReadonlyArray<readonly [string, () => string | null]> = [
    ['a different terminal inbound sequence', () => `
      inbound_seq = inbound_seq + 1000,
      inbound_seq_key = inbound_seq_key + 1000
    `],
    ['a null terminal inbound sequence', () => 'inbound_seq = NULL, inbound_seq_key = -1'],
    ['a different terminal conversation', () => "conversation_key = 'other-conversation'"],
    ['a different terminal delivery JID', () => "delivery_jid = 'other@g.us'"],
    ['a different terminal conversation and delivery JID', () => (
      "conversation_key = 'other-conversation', delivery_jid = 'other@g.us'"
    )],
    ['a selected outbound that is not terminal', () => null],
  ];

  it.each(reconciliationMismatches)('does not reconcile corroboration across %s', (_case, mismatchSql) => {
    const inboundSeq = engine.journalInbound(
      `mismatch-${_case}`,
      CONVERSATION_KEY,
      DELIVERY_JID,
      'agent',
    );
    const selectedOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{}', 'maybe_sent', ?, 1, 'unsafe')
    `).run(CONVERSATION_KEY, DELIVERY_JID, inboundSeq).lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        echoed_at, source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{}', 'echoed', datetime('now'), ?, 0, 'unsafe')
    `).run(CONVERSATION_KEY, DELIVERY_JID, inboundSeq);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'mismatch-manager', 1, 'failed',
                'failed_terminal', 'delivery_unknown', ?, 0)
    `).run(
      CONVERSATION_KEY,
      DELIVERY_JID,
      inboundSeq,
      inboundSeq,
      `mismatch-turn-${inboundSeq}`,
      selectedOpId,
    ).lastInsertRowid);
    const terminalMismatch = mismatchSql();
    if (terminalMismatch === null) {
      db.raw.prepare('UPDATE outbound_ops SET is_terminal = 0 WHERE id = ?').run(selectedOpId);
    } else {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET ${terminalMismatch} WHERE id = ?
      `).run(terminalRecordId);
    }
    const evidence = new DurabilityRecoveryEvidence(db);
    const receipt = evidence.start(
      'post_connect_recovery',
      'test_identity_mismatch',
      'test terminal-selected identity mismatch',
    );

    expect(evidence.reconcileDeliveryCorroboration(receipt)).toBe(0);
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM turn_delivery_corroboration
      WHERE terminal_record_id = ?
    `).get(terminalRecordId)).toEqual({ count: 0 });
    expect(evidence.hasDeliveryCorroboration(selectedOpId)).toBe(false);
  });

  it('corroborates all seven later echoes and preserves the selected delivery and owner receipt', () => {
    const { terminalRecordId, recoveryJobId } = seedIncident();
    const selectedBefore = rowJson(db, 'outbound_ops', 'id', INCIDENT_SELECTED_OP_ID);
    const terminalBefore = rowJson(db, 'turn_terminal_records', 'id', terminalRecordId);
    const jobBefore = rowJson(db, 'turn_recovery_jobs', 'id', recoveryJobId);
    const sourceCountBefore = db.raw.prepare(
      'SELECT COUNT(*) AS count FROM outbound_ops WHERE source_inbound_seq = ?',
    ).get(INCIDENT_INBOUND_SEQ);

    const freshEngine = new DurabilityEngine(db);
    const freshReplyGuarantee = new ReplyGuaranteeManager({
      durability: freshEngine,
      sendFallback: vi.fn(async () => undefined),
    });
    expect(freshReplyGuarantee.isArmed(INCIDENT_INBOUND_SEQ)).toBe(false);
    const stats = freshEngine.postConnectRecovery();

    expect(stats.recoveryPlanId).toEqual(expect.any(String));
    expect(stats.recoveryRunId).toEqual(expect.any(Number));
    expect(db.raw.prepare(`
      SELECT recovery_plan_id, completed_at
      FROM recovery_runs
      WHERE id = ?
    `).get(stats.recoveryRunId as number)).toEqual({
      recovery_plan_id: stats.recoveryPlanId,
      completed_at: expect.any(String),
    });

    expect(db.raw.prepare(`
      SELECT corroborating_op_id
      FROM turn_delivery_corroboration
      WHERE terminal_record_id = ?
      ORDER BY corroborating_op_id
    `).all(terminalRecordId)).toEqual(
      INCIDENT_ECHOED_OP_IDS.map((corroborating_op_id) => ({ corroborating_op_id })),
    );
    expect(rowJson(db, 'outbound_ops', 'id', INCIDENT_SELECTED_OP_ID)).toBe(selectedBefore);
    expect(rowJson(db, 'turn_terminal_records', 'id', terminalRecordId)).toBe(terminalBefore);
    expect(rowJson(db, 'turn_recovery_jobs', 'id', recoveryJobId)).toBe(jobBefore);
    expect(db.raw.prepare(
      'SELECT COUNT(*) AS count FROM outbound_ops WHERE source_inbound_seq = ?',
    ).get(INCIDENT_INBOUND_SEQ)).toEqual(sourceCountBefore);
    expect(db.raw.prepare(`
      SELECT evidence_ref
      FROM turn_delivery_corroboration
      ORDER BY corroborating_op_id
    `).all()).toEqual(INCIDENT_ECHOED_OP_IDS.map(() => ({
      evidence_ref: expect.stringMatching(
        new RegExp(`^recovery_plan:${stats.recoveryPlanId}/recovery_run:${stats.recoveryRunId}/`),
      ),
    })));

    const proofCount = db.raw.prepare(
      'SELECT COUNT(*) AS count FROM turn_delivery_corroboration',
    ).get();
    freshEngine.postConnectRecovery();
    expect(db.raw.prepare(
      'SELECT COUNT(*) AS count FROM turn_delivery_corroboration',
    ).get()).toEqual(proofCount);
  });

  it('does not create recurring live-recovery evidence for corroborated maybe_sent proof', () => {
    seedIncident();
    db.raw.prepare(
      "UPDATE outbound_ops SET created_at = datetime('now', '-31 seconds') WHERE id = ?",
    ).run(INCIDENT_SELECTED_OP_ID);
    const freshEngine = new DurabilityEngine(db);
    freshEngine.postConnectRecovery();
    const before = db.raw.prepare(
      'SELECT COUNT(*) AS count FROM recovery_runs',
    ).get();

    const stats = freshEngine.reconcileLiveMaybeSent();

    expect(stats.outboundReconciled).toBe(0);
    expect(db.raw.prepare(
      'SELECT COUNT(*) AS count FROM recovery_runs',
    ).get()).toEqual(before);
  });

  it('starts post-connect plan and run before any corroboration or outbound mutation', () => {
    const { terminalRecordId } = seedIncident();
    const selectedBefore = rowJson(db, 'outbound_ops', 'id', INCIDENT_SELECTED_OP_ID);
    db.raw.exec(`
      CREATE TRIGGER deny_post_connect_plan
      BEFORE INSERT ON recovery_plans
      BEGIN
        SELECT RAISE(ABORT, 'post-connect plan denied');
      END
    `);

    expect(() => engine.postConnectRecovery()).toThrow('post-connect plan denied');
    expect(rowJson(db, 'outbound_ops', 'id', INCIDENT_SELECTED_OP_ID)).toBe(selectedBefore);
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM turn_delivery_corroboration
      WHERE terminal_record_id = ?
    `).get(terminalRecordId)).toEqual({ count: 0 });
  });
});

describe('recovery_runs status column', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it("persists status 'started' for a fresh recovery run", () => {
    const evidence = new DurabilityRecoveryEvidence(db);
    const receipt = evidence.start('pre_connect_recovery', 'status-started', 'fresh run');

    // Inverse-correlation invariant: a fresh 'started' row must have a NULL
    // completed_at. The companion durability.test.ts asserts the forward
    // direction (status='completed' implies completed_at NOT NULL); without
    // this, a future start() that pre-stamped completed_at would leave a
    // self-contradictory 'started'-with-completed row uncaught.
    expect(db.raw.prepare('SELECT status, completed_at FROM recovery_runs WHERE id = ?')
      .get(receipt.recoveryRunId)).toEqual({ status: 'started', completed_at: null });
  });

  it("persists status 'completed' after finalize", () => {
    const evidence = new DurabilityRecoveryEvidence(db);
    const receipt = evidence.start('pre_connect_recovery', 'status-completed', 'finalized run');

    evidence.finalize(receipt, createRecoveryStats(receipt), 'done');

    expect(db.raw.prepare('SELECT status FROM recovery_runs WHERE id = ?')
      .get(receipt.recoveryRunId)).toEqual({ status: 'completed' });
  });

  it("persists status 'failed' after recordIncomplete", () => {
    const evidence = new DurabilityRecoveryEvidence(db);
    const receipt = evidence.start('pre_connect_recovery', 'status-failed', 'incomplete run');

    evidence.recordIncomplete(
      receipt,
      createRecoveryStats(receipt),
      JSON.stringify({ status: 'incomplete' }),
    );

    expect(db.raw.prepare('SELECT status FROM recovery_runs WHERE id = ?')
      .get(receipt.recoveryRunId)).toEqual({ status: 'failed' });
  });

  it("persists status 'failed' when a recovery run fails via failImmediately", () => {
    const evidence = new DurabilityRecoveryEvidence(db);
    const run = evidence.begin(
      'preConnectRecovery',
      'pre_connect_recovery',
      'status-fail-immediately',
      'fails immediately',
    );

    expect(() => run.failImmediately('some_phase', new Error('boom'))).toThrow('boom');

    expect(db.raw.prepare(`
      SELECT status FROM recovery_runs WHERE trigger = 'status-fail-immediately'
    `).get()).toEqual({ status: 'failed' });
  });
});

describe('migration 45 recovery_runs status backfill', () => {
  it("backfills completed rows to 'completed' and leaves incomplete rows at 'started'", () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec(`
        CREATE TABLE recovery_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          trigger TEXT NOT NULL,
          notes TEXT
        );
      `);
      raw.prepare(`
        INSERT INTO recovery_runs (id, completed_at, trigger)
        VALUES (1, datetime('now'), 'pre_connect')
      `).run();
      raw.prepare(`
        INSERT INTO recovery_runs (id, completed_at, trigger)
        VALUES (2, NULL, 'pre_connect')
      `).run();

      runMigration45(raw);

      expect(raw.prepare('SELECT status FROM recovery_runs WHERE id = 1').get())
        .toEqual({ status: 'completed' });
      expect(raw.prepare('SELECT status FROM recovery_runs WHERE id = 2').get())
        .toEqual({ status: 'started' });
    } finally {
      raw.close();
    }
  });

  it('is a no-op when recovery_runs does not exist', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      expect(() => runMigration45(raw)).not.toThrow();
      // A true no-op: the migration must NOT side-effect a recovery_runs table
      // into existence when it was absent. Asserting only not.toThrow() is
      // vacuous — it would also pass if runMigration45 were deleted outright
      // or if it silently created the table.
      expect(raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_runs'",
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});
