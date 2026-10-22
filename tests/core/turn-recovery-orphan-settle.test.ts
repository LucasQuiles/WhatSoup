import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DEFAULT_DATABASE_RETENTION, runDatabaseRetention } from '../../src/core/database-retention.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { TurnRecoveryOwnerIdentity } from '../../src/core/durability.ts';
import { closeOperatorCatchupRecovery } from '../../src/core/recovery-catchup-closure.ts';
import {
  ORPHAN_TRANSFER_SETTLE_ACTOR,
  OrphanTransferSettler,
  orphanTransferSettlePlanId,
  type EligibleOrphanTransferSettle,
} from '../../src/core/turn-recovery-orphan-settle.ts';
import { getTurnRecoveryHealthDetails } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';
import { classifyRuntimeRecoveryHealth } from '../../src/runtimes/agent/runtime-recovery-health.ts';
import { TurnRecoverySupervisor } from '../../src/runtimes/agent/turn-recovery-supervisor.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

/**
 * Operator settle of an orphan recovery transfer (a transferred terminal
 * record with no job row). Admission is an allowlist: a corroborated
 * `maybe_sent` terminal op with no provider message id, and a terminal source
 * inbound that is not echo-settled. Settling writes the missing job in the
 * settled `exhausted` state plus an append-only operator plan, must clear
 * every gauge the orphan fed, must keep the terminal record byte-identical,
 * and must stay settled through every runtime pass.
 *
 * How an orphan arises is not established, and live finalization always writes
 * the record with its job. Every fixture below therefore removes the job with a
 * hand DELETE. That DELETE is a STRUCTURAL STAND-IN for "a record with no
 * linked job"; it does not claim to reproduce any production generator.
 */
type Transfer = { jobId: number; recordId: number; inboundSeq: number; opId: number; conversationKey: string };
type SourceState = 'failed' | 'complete_echoed' | 'complete_other' | 'open';

describe('operator settle of an orphan recovery transfer', () => {
  let db: Database;
  let durability: DurabilityEngine;

  const OWNER: TurnRecoveryOwnerIdentity = {
    logicalTurnId: 'orphan-settle-owner-turn',
    managerId: 'orphan-settle-manager',
    generation: 1,
  };
  const EVIDENCE_REF = 'ops/orphan-settle-fixture';

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  /** Structural stand-in: remove the linked job so the record is an orphan. */
  function orphanize(jobId: number): void {
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?').run(jobId);
  }

  function setSource(seq: number, source: SourceState): void {
    if (source === 'failed') durability.markInboundFailed(seq, 'crash_recovery');
    if (source === 'complete_echoed') durability.markInboundComplete(seq, 'response_echoed');
    if (source === 'complete_other') durability.markInboundComplete(seq, 'no_reply_policy');
  }

  /**
   * The observed production shape: a `delivery_unknown` transfer whose
   * selected op is `maybe_sent`, terminal, never submitted and without a
   * provider message id, corroborated by a later echoed op for the same source.
   */
  function unknownDeliveryOrphan(
    suffix: string,
    options: {
      source?: SourceState;
      corroborate?: boolean;
      waMessageId?: string;
      owner?: TurnRecoveryOwnerIdentity;
    } = {},
  ): Transfer {
    const { source = 'failed', corroborate = true, waMessageId, owner = OWNER } = options;
    const conversationKey = `orphan-settle-${suffix}`;
    const deliveryJid = `${conversationKey}@s.whatsapp.net`;
    const messageId = `wamid-orphan-settle-${suffix}`;
    const inboundSeq = durability.journalInbound(messageId, conversationKey, deliveryJid, 'agent');
    const opId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'send_text',
      payload: '{"text":"uncertain selected delivery"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(opId);
    durability.markMaybeSent(opId, 'transport result unknown', waMessageId);
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey,
        deliveryJid,
        inboundSeq,
        logicalTurnId: `turn-${suffix}`,
        managerId: 'orphan-settle-manager',
        generation: 1,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'delivery_unknown', opId },
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, {
        sourceMessageId: messageId,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: 'orphan-settle-sender@s.whatsapp.net',
        senderName: 'Orphan Settle Fixture',
        text: `orphan settle fixture ${suffix}`,
        isGroup: false,
      }),
    });
    setSource(inboundSeq, source);
    if (corroborate) {
      const corroboratingOpId = durability.createOutboundOp({
        conversationKey,
        chatJid: deliveryJid,
        opType: 'send_text',
        payload: '{"text":"later echoed delivery"}',
        replayPolicy: 'unsafe',
        sourceInboundSeq: inboundSeq,
      });
      durability.markSending(corroboratingOpId);
      durability.markSubmitted(corroboratingOpId, `wa-orphan-settle-corroborating-${suffix}`);
      durability.markEchoed(corroboratingOpId);
      // Post-connect recovery appends the corroboration row.
      durability.postConnectRecovery();
    }
    const jobId = receipt.recoveryJob!.jobId;
    orphanize(jobId);
    return { jobId, recordId: receipt.recordId, inboundSeq, opId, conversationKey };
  }

  /** A transfer whose selected op is still `pending` in the queue, with its job. */
  function enqueuedTransfer(suffix: string): Transfer {
    const conversationKey = `orphan-settle-${suffix}`;
    const deliveryJid = `${conversationKey}@s.whatsapp.net`;
    const messageId = `wamid-orphan-settle-${suffix}`;
    const inboundSeq = durability.journalInbound(messageId, conversationKey, deliveryJid, 'agent');
    const opId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'text',
      payload: JSON.stringify({ text: `selected ${suffix}` }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
    });
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey,
        deliveryJid,
        inboundSeq,
        logicalTurnId: `turn-${suffix}`,
        managerId: 'orphan-settle-manager',
        generation: 1,
      },
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId },
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, {
        sourceMessageId: messageId,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: '15550100001:7@s.whatsapp.net',
        senderName: 'Orphan Settle Fixture',
        text: `orphan settle fixture ${suffix}`,
        isGroup: false,
      }),
    });
    return { jobId: receipt.recoveryJob!.jobId, recordId: receipt.recordId, inboundSeq, opId, conversationKey };
  }

  function health() {
    return classifyRuntimeRecoveryHealth({
      finalization: {
        retainedRetries: 0,
        degradedScopes: 0,
        retryAttempts: 0,
        retryRecoveries: 0,
        retryExhaustions: 0,
      },
      recovery: getTurnRecoveryHealthDetails(durability),
      completedDeliveryIdentity: { unresolvedCount: 0, nextAction: null },
    });
  }

  const terminalRow = (id: number): unknown =>
    db.raw.prepare('SELECT * FROM turn_terminal_records WHERE id = ?').get(id);
  const jobRow = (id: number): unknown =>
    db.raw.prepare('SELECT * FROM turn_recovery_jobs WHERE id = ?').get(id);
  const inboundRow = (seq: number): unknown =>
    db.raw.prepare(
      'SELECT seq, processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
    ).get(seq);
  const outboundSnapshot = (): unknown[] =>
    db.raw.prepare(
      'SELECT id, status, is_terminal, wa_message_id, retry_count FROM outbound_ops ORDER BY id',
    ).all();
  const rowCount = (table: string): number =>
    Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  function settle(terminalId: number): { jobId: number } {
    const settler = new OrphanTransferSettler(db.raw);
    const evaluation = settler.evaluate(terminalId);
    expect(evaluation.verdict).toBe('eligible');
    db.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = settler.applyWithinCallerTransaction(
        evaluation as EligibleOrphanTransferSettle,
        EVIDENCE_REF,
      );
      db.raw.exec('COMMIT');
      return result;
    } catch (err) {
      db.raw.exec('ROLLBACK');
      throw err;
    }
  }

  function refusal(terminalId: number): unknown {
    return new OrphanTransferSettler(db.raw).evaluate(terminalId);
  }

  it('admits the production shape and reports every admission input', () => {
    const t = unknownDeliveryOrphan('shape');
    const source = db.raw.prepare('SELECT terminal_reason FROM inbound_events WHERE seq = ?')
      .get(t.inboundSeq) as { terminal_reason: string | null };

    expect(new OrphanTransferSettler(db.raw).evaluate(t.recordId)).toEqual({
      verdict: 'eligible',
      terminalId: t.recordId,
      planId: orphanTransferSettlePlanId(t.recordId),
      scope: 'per_chat',
      inboundSeq: t.inboundSeq,
      deliveryKind: 'delivery_unknown',
      deliveryOpId: t.opId,
      deliveryStatus: 'maybe_sent',
      deliveryIsTerminal: true,
      deliveryHasWaMessageId: false,
      deliveryIdentityMatches: true,
      sourceInboundIdentityMatches: true,
      sourceInboundStatus: 'failed',
      sourceInboundTerminalReason: source.terminal_reason,
      corroborated: true,
      isGroup: false,
      conversationKey: 'orphan-settle-shape',
      deliveryJid: 'orphan-settle-shape@s.whatsapp.net',
      sourceLogicalTurnId: 'turn-shape',
      sourceManagerId: 'orphan-settle-manager',
      sourceGeneration: 1,
      sourceMessageId: 'wamid-orphan-settle-shape',
      recoveryOwnerLogicalTurnId: OWNER.logicalTurnId,
      recoveryOwnerManagerId: OWNER.managerId,
      recoveryOwnerGeneration: OWNER.generation,
    });
  });

  it('clears orphan_transfers, corrupt_links and turn_recovery_integrity once settled', () => {
    const t = unknownDeliveryOrphan('clears');
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      orphanTransfers: 1,
      corruptLinks: 1,
      blockingOutstanding: 0,
      corroboratedRetained: 1,
    });
    expect(health().blockingReasons).toEqual(['turn_recovery_integrity']);

    settle(t.recordId);

    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 0,
      blockingOutstanding: 0,
      corroboratedRetained: 0,
      orphanTransfers: 0,
      corruptLinks: 0,
      corruptLinksSettled: 0,
      echoConflicts: 0,
      echoConflictsSettled: 0,
      exhausted: 1,
      retainedTerminal: 1,
    });
    const classification = health();
    expect(classification.blockingReasons).toEqual([]);
    expect(classification.blocking).toBe(false);
    expect(classification.retainedReasons).toContain('turn_recovery_terminal');
  });

  it('stays settled through startup and live recovery, the sweep, the supervisor and retention', async () => {
    const t = unknownDeliveryOrphan('stays');
    const { jobId } = settle(t.recordId);
    // Stand-in for age: put the source inbound's completion past the retention cutoff.
    db.raw.prepare(`UPDATE inbound_events SET completed_at = datetime('now', '-40 days') WHERE seq = ?`)
      .run(t.inboundSeq);
    const jobBefore = jobRow(jobId);
    const terminalBefore = terminalRow(t.recordId);
    const inboundBefore = inboundRow(t.inboundSeq);
    const outboundBefore = outboundSnapshot();
    const dispatchReplay = vi.fn(async () => ({ kind: 'delivered' }) as const);
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'orphan-settle-test',
      durability: () => durability,
      dispatchReplay,
      freshOwnerIdentity: () => ({
        logicalTurnId: 'orphan-settle-fresh-owner',
        managerId: 'orphan-settle-fresh-manager',
        generation: 1,
      }),
    });

    durability.preConnectRecovery();
    durability.postConnectRecovery();
    durability.reconcileLiveMaybeSent();
    durability.sweepStuckInbound();
    durability.recoverStaleTurnRecoveryJobs();
    const scan = await supervisor.scanOnce();
    runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(dispatchReplay).not.toHaveBeenCalled();
    expect(scan.claimed).toBe(0);
    expect(jobRow(jobId)).toEqual(jobBefore);
    expect(terminalRow(t.recordId)).toEqual(terminalBefore);
    expect(inboundRow(t.inboundSeq)).toEqual(inboundBefore);
    expect(outboundSnapshot()).toEqual(outboundBefore);
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      orphanTransfers: 0,
      corruptLinks: 0,
      echoConflicts: 0,
      echoConflictsSettled: 0,
      exhausted: 1,
    });
    expect(new OrphanTransferSettler(db.raw).evaluate(t.recordId)).toMatchObject({
      verdict: 'already_settled', jobId,
    });
  });

  it('no echo can reach the settled record: no message id to match, and the op is frozen', () => {
    const t = unknownDeliveryOrphan('frozen');
    const { jobId } = settle(t.recordId);
    const jobBefore = jobRow(jobId);
    const outboundBefore = outboundSnapshot();

    // A late own-message echo correlates only by provider message id (matchEcho);
    // the admitted op has none, so no echo can ever select it.
    expect(db.raw.prepare('SELECT wa_message_id FROM outbound_ops WHERE id = ?').get(t.opId))
      .toEqual({ wa_message_id: null });
    // Corroboration makes the selected op immutable, so even a direct echo write aborts.
    expect(() => durability.markEchoed(t.opId)).toThrow(/immutable/);

    expect(jobRow(jobId)).toEqual(jobBefore);
    expect(outboundSnapshot()).toEqual(outboundBefore);
  });

  it('keeps the terminal record unchanged and writes an auditable, non-replayable closing entry', () => {
    const t = unknownDeliveryOrphan('evidence');
    const before = terminalRow(t.recordId);

    const { jobId } = settle(t.recordId);

    expect(terminalRow(t.recordId)).toEqual(before);
    expect(db.raw.prepare(`
      SELECT terminal_record_id, state, attempt_count, claim_token, replay_safe,
             replay_safety_proof_id, assigned_owner_manager_id, completion_kind, echo_conflict_at
      FROM turn_recovery_jobs WHERE id = ?
    `).get(jobId)).toEqual({
      terminal_record_id: t.recordId,
      state: 'exhausted',
      attempt_count: 5,
      claim_token: null,
      replay_safe: 0,
      replay_safety_proof_id: orphanTransferSettlePlanId(t.recordId),
      assigned_owner_manager_id: ORPHAN_TRANSFER_SETTLE_ACTOR,
      completion_kind: null,
      echo_conflict_at: null,
    });
    expect(db.raw.prepare(
      'SELECT origin, actor, evidence_ref FROM recovery_plans WHERE plan_id = ?',
    ).get(orphanTransferSettlePlanId(t.recordId))).toEqual({
      origin: 'operator',
      actor: ORPHAN_TRANSFER_SETTLE_ACTOR,
      evidence_ref: `orphan-transfer-settle:v1;terminal=${t.recordId};op=${t.opId};ref=${EVIDENCE_REF}`,
    });
    // Every admitted orphan carries delivery corroboration, so the BEFORE DELETE
    // trigger corroborated_terminal_proof_retain (database-migration-41.ts)
    // refuses the delete before any foreign-key check runs.
    expect(() => db.raw.prepare('DELETE FROM turn_terminal_records WHERE id = ?').run(t.recordId))
      .toThrow(/corroborated terminal proof must be retained/);
    expect(terminalRow(t.recordId)).toEqual(before);
  });

  it('still refuses to delete a settled record through its RESTRICT foreign keys when the retain trigger is absent', () => {
    const t = unknownDeliveryOrphan('evidence-fk');
    settle(t.recordId);
    const before = terminalRow(t.recordId);
    // Remove the trigger layer on this in-memory fixture only, to show the
    // foreign-key layer on its own. The RESTRICT keys referencing the record
    // are the corroboration row's and the settled job's (database-migration-41.ts,
    // database-migrations-37-40.ts); either one refuses the delete.
    db.raw.exec('DROP TRIGGER corroborated_terminal_proof_retain');

    expect(() => db.raw.prepare('DELETE FROM turn_terminal_records WHERE id = ?').run(t.recordId))
      .toThrow(/FOREIGN KEY/);
    expect(terminalRow(t.recordId)).toEqual(before);
  });

  it('evaluating writes nothing', () => {
    const t = unknownDeliveryOrphan('dry');
    const counts = ['turn_recovery_jobs', 'recovery_plans', 'turn_terminal_records']
      .map((table) => rowCount(table));

    expect(new OrphanTransferSettler(db.raw).evaluate(t.recordId)).toMatchObject({ verdict: 'eligible' });

    expect(['turn_recovery_jobs', 'recovery_plans', 'turn_terminal_records'].map((table) => rowCount(table)))
      .toEqual(counts);
    expect(durability.getTurnRecoverySupervisorCounts().orphanTransfers).toBe(1);
  });

  it('a second settle is a no-op report', () => {
    const t = unknownDeliveryOrphan('idempotent');
    const { jobId } = settle(t.recordId);
    const jobs = rowCount('turn_recovery_jobs');
    const plans = rowCount('recovery_plans');

    expect(new OrphanTransferSettler(db.raw).evaluate(t.recordId)).toEqual({
      verdict: 'already_settled',
      terminalId: t.recordId,
      planId: orphanTransferSettlePlanId(t.recordId),
      jobId,
    });
    expect(rowCount('turn_recovery_jobs')).toBe(jobs);
    expect(rowCount('recovery_plans')).toBe(plans);
  });

  it('admits a complete source inbound whose reason is not response_echoed', () => {
    const t = unknownDeliveryOrphan('complete-other', { source: 'complete_other' });
    expect(refusal(t.recordId)).toMatchObject({ verdict: 'eligible', sourceInboundStatus: 'complete' });
  });

  // Owner separation is on the full (logical turn, manager, generation) tuple:
  // the job CHECK turn_recovery_owner_separation and the finalize contract.
  // An owner that shares only part of the source identity is a separate owner.
  it('admits and settles an owner that shares the source logical turn id but not its manager id', () => {
    const t = unknownDeliveryOrphan('owner-other-manager', {
      owner: { logicalTurnId: 'turn-owner-other-manager', managerId: 'orphan-settle-other-manager', generation: 1 },
    });

    expect(refusal(t.recordId)).toMatchObject({
      verdict: 'eligible',
      sourceLogicalTurnId: 'turn-owner-other-manager',
      sourceManagerId: 'orphan-settle-manager',
      sourceGeneration: 1,
      recoveryOwnerLogicalTurnId: 'turn-owner-other-manager',
      recoveryOwnerManagerId: 'orphan-settle-other-manager',
      recoveryOwnerGeneration: 1,
    });
    const { jobId } = settle(t.recordId);
    expect(jobRow(jobId)).toMatchObject({ state: 'exhausted', owner_manager_id: 'orphan-settle-other-manager' });
  });

  it('admits and settles an owner that shares the source logical turn id but not its generation', () => {
    const t = unknownDeliveryOrphan('owner-other-generation', {
      owner: { logicalTurnId: 'turn-owner-other-generation', managerId: 'orphan-settle-manager', generation: 2 },
    });

    expect(refusal(t.recordId)).toMatchObject({
      verdict: 'eligible',
      sourceLogicalTurnId: 'turn-owner-other-generation',
      sourceManagerId: 'orphan-settle-manager',
      sourceGeneration: 1,
      recoveryOwnerLogicalTurnId: 'turn-owner-other-generation',
      recoveryOwnerManagerId: 'orphan-settle-manager',
      recoveryOwnerGeneration: 2,
    });
    const { jobId } = settle(t.recordId);
    expect(jobRow(jobId)).toMatchObject({ state: 'exhausted', owner_generation: 2 });
  });


  it('a complete, not echo-settled source stays settled through every runtime pass and moves each gauge by one', async () => {
    const t = unknownDeliveryOrphan('stays-complete', { source: 'complete_other' });
    expect(inboundRow(t.inboundSeq)).toMatchObject({
      processing_status: 'complete',
      terminal_reason: 'no_reply_policy',
    });
    const countsBefore = durability.getTurnRecoverySupervisorCounts();
    expect(countsBefore).toMatchObject({ orphanTransfers: 1, corruptLinks: 1, outstanding: 1 });
    expect(health().blockingReasons).toEqual(['turn_recovery_integrity']);

    const { jobId } = settle(t.recordId);
    // Stand-in for age: put the source inbound's completion past the retention cutoff.
    db.raw.prepare(`UPDATE inbound_events SET completed_at = datetime('now', '-40 days') WHERE seq = ?`)
      .run(t.inboundSeq);
    const corroborationRows = (): unknown[] => db.raw.prepare(
      'SELECT * FROM turn_delivery_corroboration WHERE terminal_record_id = ? ORDER BY corroborating_op_id',
    ).all(t.recordId);
    const jobBefore = jobRow(jobId);
    const terminalBefore = terminalRow(t.recordId);
    const inboundBefore = inboundRow(t.inboundSeq);
    const outboundBefore = outboundSnapshot();
    const corroborationBefore = corroborationRows();
    expect(corroborationBefore).toHaveLength(1);
    const dispatchReplay = vi.fn(async () => ({ kind: 'delivered' }) as const);
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'orphan-settle-test',
      durability: () => durability,
      dispatchReplay,
      freshOwnerIdentity: () => ({
        logicalTurnId: 'orphan-settle-fresh-owner',
        managerId: 'orphan-settle-fresh-manager',
        generation: 1,
      }),
    });

    durability.preConnectRecovery();
    durability.postConnectRecovery();
    durability.reconcileLiveMaybeSent();
    durability.sweepStuckInbound();
    durability.recoverStaleTurnRecoveryJobs();
    const scan = await supervisor.scanOnce();
    runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(dispatchReplay).not.toHaveBeenCalled();
    expect(scan.claimed).toBe(0);
    expect(jobRow(jobId)).toEqual(jobBefore);
    expect(terminalRow(t.recordId)).toEqual(terminalBefore);
    expect(inboundRow(t.inboundSeq)).toEqual(inboundBefore);
    expect(outboundSnapshot()).toEqual(outboundBefore);
    expect(corroborationRows()).toEqual(corroborationBefore);
    // Runbook "Verify after apply": the orphan drops out of orphan, corrupt-link,
    // outstanding and corroborated-retained counts; exhausted and retained
    // terminal rise by one; nothing else moves.
    const countsAfter = durability.getTurnRecoverySupervisorCounts();
    const delta = (key: keyof typeof countsAfter): number =>
      Number(countsAfter[key] ?? 0) - Number(countsBefore[key] ?? 0);
    expect({
      orphanTransfers: delta('orphanTransfers'),
      corruptLinks: delta('corruptLinks'),
      outstanding: delta('outstanding'),
      corroboratedRetained: delta('corroboratedRetained'),
      blockingOutstanding: delta('blockingOutstanding'),
      exhausted: delta('exhausted'),
      retainedTerminal: delta('retainedTerminal'),
      blockedUnsafe: delta('blockedUnsafe'),
      pending: delta('pending'),
      liveClaimed: delta('liveClaimed'),
      expiredClaimed: delta('expiredClaimed'),
      echoConflicts: delta('echoConflicts'),
    }).toEqual({
      orphanTransfers: -1,
      corruptLinks: -1,
      outstanding: -1,
      corroboratedRetained: -1,
      blockingOutstanding: 0,
      exhausted: 1,
      retainedTerminal: 1,
      blockedUnsafe: 0,
      pending: 0,
      liveClaimed: 0,
      expiredClaimed: 0,
      echoConflicts: 0,
    });
    expect(countsAfter).toMatchObject({ orphanTransfers: 0, corruptLinks: 0, outstanding: 0 });
    const classification = health();
    expect(classification.blockingReasons).toEqual([]);
    expect(classification.blocking).toBe(false);
    expect(classification.retainedReasons).toContain('turn_recovery_terminal');
    expect(new OrphanTransferSettler(db.raw).evaluate(t.recordId)).toMatchObject({
      verdict: 'already_settled', jobId,
    });
  });

  describe('refusals leave the orphan untouched', () => {
    /** Every row of every table the settle reads or writes, in rowid order. */
    const SETTLE_STATE_TABLES = [
      'turn_terminal_records',
      'outbound_ops',
      'inbound_events',
      'turn_delivery_corroboration',
      'inbound_disposition_links',
      'turn_recovery_jobs',
      'recovery_plans',
    ] as const;
    const settleState = (): Record<string, unknown[]> => Object.fromEntries(SETTLE_STATE_TABLES.map(
      (table) => [table, db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ));

    function expectRefused(t: Transfer, reason: string): void {
      const before = settleState();
      expect(refusal(t.recordId)).toEqual({ verdict: 'refused', terminalId: t.recordId, reason });
      expect(settleState()).toEqual(before);
      expect(durability.getTurnRecoverySupervisorCounts().orphanTransfers).toBeGreaterThanOrEqual(1);
    }

    it('refuses a selected op the queue still owns: pending, sending, submitted', () => {
      const pending = enqueuedTransfer('pending');
      orphanize(pending.jobId);
      expectRefused(pending, 'delivery_status_not_admitted');

      const sending = enqueuedTransfer('sending');
      durability.markSending(sending.opId);
      orphanize(sending.jobId);
      expectRefused(sending, 'delivery_status_not_admitted');

      const submitted = enqueuedTransfer('submitted');
      durability.markSending(submitted.opId);
      durability.markSubmitted(submitted.opId, 'wa-orphan-settle-submitted');
      orphanize(submitted.jobId);
      expectRefused(submitted, 'delivery_status_not_admitted');
    });

    it('refuses an echoed selected op', () => {
      const t = enqueuedTransfer('echoed');
      durability.markSending(t.opId);
      durability.markSubmitted(t.opId, 'wa-orphan-settle-echoed');
      orphanize(t.jobId);
      durability.markEchoed(t.opId);
      expectRefused(t, 'delivery_status_not_admitted');
    });

    it('refuses a maybe_sent op without a valid corroboration', () => {
      expectRefused(unknownDeliveryOrphan('uncorroborated', { corroborate: false }), 'uncorroborated');
    });

    it('refuses a maybe_sent op that is not terminal', () => {
      const t = unknownDeliveryOrphan('not-terminal', { corroborate: false });
      // Structural stand-in: finalization always marks the selected op terminal.
      db.raw.prepare('UPDATE outbound_ops SET is_terminal = 0 WHERE id = ?').run(t.opId);
      expectRefused(t, 'delivery_not_terminal');
    });

    it('refuses a selected op that carries a provider message id (B)', () => {
      expectRefused(
        unknownDeliveryOrphan('wa-id', { waMessageId: 'wa-orphan-settle-late-matchable' }),
        'delivery_has_wa_message_id',
      );
    });

    it('refuses a selected op whose identity differs from the record', () => {
      const t = unknownDeliveryOrphan('op-identity', { corroborate: false });
      // Structural stand-in: finalization only selects an op of the turn's own
      // conversation; the identity trigger no longer guards it once the job is gone.
      db.raw.prepare(`UPDATE outbound_ops SET chat_jid = 'orphan-settle-elsewhere@s.whatsapp.net' WHERE id = ?`)
        .run(t.opId);
      expectRefused(t, 'delivery_identity_mismatch');
    });

    it('refuses a source inbound whose identity differs from the record', () => {
      const t = unknownDeliveryOrphan('inbound-identity');
      // Structural stand-in: nothing guards an orphan's inbound identity once its
      // job is gone, so a rewrite here would make the settled job a broken link.
      db.raw.prepare(`UPDATE inbound_events SET chat_jid = 'orphan-settle-elsewhere@s.whatsapp.net' WHERE seq = ?`)
        .run(t.inboundSeq);
      expectRefused(t, 'source_inbound_identity_mismatch');
    });

    it('refuses an open source inbound', () => {
      expectRefused(unknownDeliveryOrphan('open-source', { source: 'open' }), 'source_inbound_open');
    });

    it('refuses a source inbound completed as response_echoed (A)', () => {
      expectRefused(
        unknownDeliveryOrphan('echo-settled', { source: 'complete_echoed' }),
        'source_inbound_echo_settled',
      );
    });

    it('refuses a transfer that still has its recovery job', () => {
      const t = enqueuedTransfer('live-job');
      expect(refusal(t.recordId)).toEqual({
        verdict: 'refused', terminalId: t.recordId, reason: 'recovery_job_exists',
      });
    });

    it('refuses a record that is not a transfer, and an unknown record', () => {
      const seq = durability.journalInbound('wamid-orphan-settle-final', 'orphan-settle-final', 'orphan-settle-final@s.whatsapp.net', 'agent');
      const receipt = durability.finalizeTurnTerminal(toTurnFinalizationPersistence({
        identity: {
          scope: 'per_chat',
          conversationKey: 'orphan-settle-final',
          deliveryJid: 'orphan-settle-final@s.whatsapp.net',
          inboundSeq: seq,
          logicalTurnId: 'turn-final',
          managerId: 'orphan-settle-manager',
          generation: 1,
        },
        attemptOutcome: { kind: 'failed', class: 'crash' },
        inboundDisposition: 'failed_terminal',
        deliveryEvidence: { kind: 'none' },
      }));
      const settler = new OrphanTransferSettler(db.raw);
      expect(settler.evaluate(receipt.recordId)).toMatchObject({ verdict: 'refused', reason: 'not_transferred' });
      expect(settler.evaluate(999_999)).toMatchObject({ verdict: 'refused', reason: 'terminal_not_found' });
    });

    /**
     * Structural stand-in: the settle's plan row plus a job shaped like the one
     * it writes, except for the given columns. Each case below breaks exactly
     * one of the three facts that make a linked job the settle's own.
     */
    function linkSettleShapedJob(
      t: Transfer,
      job: { state: 'exhausted' | 'pending'; attempts: number; actor: string; proofId: string },
    ): void {
      db.raw.prepare(`
        INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
        VALUES (?, 'operator', ?, 'stand-in settle plan', NULL)
      `).run(orphanTransferSettlePlanId(t.recordId), ORPHAN_TRANSFER_SETTLE_ACTOR);
      db.raw.prepare(`
        INSERT INTO turn_recovery_jobs (
          terminal_record_id, scope, conversation_key, delivery_jid,
          source_inbound_seq, source_inbound_seq_key,
          source_logical_turn_id, source_manager_id, source_generation, source_message_id,
          owner_logical_turn_id, owner_manager_id, owner_generation,
          assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
          replay_safe, replay_safety_proof_id, sender_jid, sender_name, replay_text,
          is_group, group_name, state, attempt_count, claim_epoch
        )
        SELECT t.id, t.scope, t.conversation_key, t.delivery_jid,
               t.inbound_seq, t.inbound_seq,
               t.logical_turn_id, t.manager_id, t.generation, i.message_id,
               t.recovery_owner_logical_turn_id, t.recovery_owner_manager_id, t.recovery_owner_generation,
               'stand-in-owner-' || t.id, ?, 1,
               0, ?, 'stand-in-sender', NULL, 'stand-in text',
               0, NULL, ?, ?, ?
        FROM turn_terminal_records t
        JOIN inbound_events i ON i.seq = t.inbound_seq
        WHERE t.id = ?
      `).run(job.actor, job.proofId, job.state, job.attempts, job.attempts, t.recordId);
    }

    function expectJobExistsRefusal(t: Transfer): void {
      const before = settleState();
      expect(refusal(t.recordId)).toEqual({
        verdict: 'refused', terminalId: t.recordId, reason: 'recovery_job_exists',
      });
      expect(settleState()).toEqual(before);
    }

    it('refuses a settle-shaped linked job that is not exhausted', () => {
      const t = unknownDeliveryOrphan('ours-state');
      linkSettleShapedJob(t, {
        state: 'pending',
        attempts: 4,
        actor: ORPHAN_TRANSFER_SETTLE_ACTOR,
        proofId: orphanTransferSettlePlanId(t.recordId),
      });
      expectJobExistsRefusal(t);
    });

    it('refuses a settle-shaped linked job assigned to another actor', () => {
      const t = unknownDeliveryOrphan('ours-actor');
      linkSettleShapedJob(t, {
        state: 'exhausted',
        attempts: 5,
        actor: 'orphan-settle-other-actor',
        proofId: orphanTransferSettlePlanId(t.recordId),
      });
      expectJobExistsRefusal(t);
    });

    it('refuses a settle-shaped linked job whose proof id is not the settle plan id', () => {
      const t = unknownDeliveryOrphan('ours-proof');
      linkSettleShapedJob(t, {
        state: 'exhausted',
        attempts: 5,
        actor: ORPHAN_TRANSFER_SETTLE_ACTOR,
        proofId: 'orphan-settle-other-proof',
      });
      expectJobExistsRefusal(t);
    });

    it('refuses an op whose stored provider message id is the empty string', () => {
      // markMaybeSent stores a given '' verbatim (COALESCE keeps it) and the
      // column has no CHECK, so '' is reachable. matchEcho selects by exact
      // wa_message_id, so an own-message echo with an empty id would match it:
      // '' is not "no message id".
      const t = unknownDeliveryOrphan('wa-empty', { waMessageId: '' });
      expect(db.raw.prepare('SELECT wa_message_id FROM outbound_ops WHERE id = ?').get(t.opId))
        .toEqual({ wa_message_id: '' });
      expectRefused(t, 'delivery_has_wa_message_id');
    });

    /**
     * Opens a `recovery_pending_operator_catchup` link on the source inbound.
     * A pending link is open while no `superseded_by_operator_catchup` row
     * exists for the same (inbound_seq, recovery_plan_id): the open_recoveries
     * predicate in turn-recovery-store.ts.
     */
    function openPendingLink(t: Transfer, planId: string): void {
      db.raw.prepare(`
        INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
        VALUES (?, 'pre_connect_recovery', 'system:test', 'fixture', 'test://fixture')
      `).run(planId);
      db.raw.prepare(`
        INSERT INTO inbound_disposition_links (
          inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
          reason, evidence_ref, actor
        ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                  'crash recovery', 'test://fixture', 'system:test')
      `).run(t.inboundSeq, planId);
    }

    /**
     * Closes the pending link of `planId` on the source inbound: a later echoed
     * reply in the same chat, built as the closure tests build it and closed
     * through the production closure path, which writes the plan's
     * `superseded_by_operator_catchup` row.
     */
    function closePendingLink(t: Transfer, planId: string, label: string): void {
      const deliveryJid = `${t.conversationKey}@s.whatsapp.net`;
      const catchupSeq = Number(db.raw.prepare(`
        INSERT INTO inbound_events (
          message_id, conversation_key, chat_jid, processing_status, completed_at, terminal_reason
        ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
      `).run(`wamid-orphan-settle-${label}-catchup`, t.conversationKey, deliveryJid).lastInsertRowid);
      const catchupOpId = Number(db.raw.prepare(`
        INSERT INTO outbound_ops (
          conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
          is_terminal, replay_policy, echoed_at
        ) VALUES (?, ?, 'text', '{"text":"ACK"}', 'echoed', ?, 1, 'unsafe', datetime('now'))
      `).run(t.conversationKey, deliveryJid, catchupSeq).lastInsertRowid);
      db.raw.prepare(`
        INSERT INTO turn_terminal_records (
          scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
          logical_turn_id, manager_id, generation, attempt_kind,
          inbound_disposition, delivery_kind, delivery_op_id,
          reply_guarantee_disarmed
        ) VALUES ('per_chat', ?, ?, ?, ?, 'catchup-turn', 'catchup-manager', 1, 'replied',
                  'finalized_replied', 'echoed', ?, 1)
      `).run(t.conversationKey, deliveryJid, catchupSeq, catchupSeq, catchupOpId);
      expect(closeOperatorCatchupRecovery(db, {
        planId,
        conversationKey: t.conversationKey,
        expectedSourceSeqs: [t.inboundSeq],
        catchupSeq,
        actor: 'operator:test',
        evidenceRef: `test://orphan-settle-${label}`,
      })).toMatchObject({ inserted: 1, openAfter: 0 });
    }

    it('refuses a record whose source inbound has an open disposition link', () => {
      const t = unknownDeliveryOrphan('open-link');
      openPendingLink(t, 'pcr-orphan-settle-open-link');
      expectRefused(t, 'open_disposition_link');
    });

    it('admits a record when the only open disposition link is on another inbound', () => {
      const linked = unknownDeliveryOrphan('link-elsewhere-linked');
      const other = unknownDeliveryOrphan('link-elsewhere-other');
      openPendingLink(linked, 'pcr-orphan-settle-link-elsewhere');
      expect(durability.getTurnRecoverySupervisorCounts().openRecoveries).toBe(1);

      expectRefused(linked, 'open_disposition_link');
      expect(refusal(other.recordId)).toMatchObject({ verdict: 'eligible' });
    });

    it('admits and settles a record whose source inbound disposition link is closed', () => {
      const t = unknownDeliveryOrphan('closed-link');
      const planId = 'pcr-orphan-settle-closed-link';
      openPendingLink(t, planId);
      closePendingLink(t, planId, 'closed-link');
      expect(durability.getTurnRecoverySupervisorCounts().openRecoveries).toBe(0);

      expect(refusal(t.recordId)).toMatchObject({ verdict: 'eligible' });
      const { jobId } = settle(t.recordId);
      expect(jobRow(jobId)).toMatchObject({ state: 'exhausted' });
    });

    it('refuses a record whose open link survives a closure for another plan on the same inbound', () => {
      // A closure closes only the pending link of its own recovery plan: plan
      // B's closure row must not close plan A's link on the same seq.
      const t = unknownDeliveryOrphan('cross-plan');
      const openPlanId = 'pcr-orphan-settle-cross-plan-open';
      const closedPlanId = 'pcr-orphan-settle-cross-plan-closed';
      openPendingLink(t, openPlanId);
      openPendingLink(t, closedPlanId);
      closePendingLink(t, closedPlanId, 'cross-plan');
      expect(db.raw.prepare(`
        SELECT recovery_plan_id, disposition FROM inbound_disposition_links
        WHERE inbound_seq = ? ORDER BY id
      `).all(t.inboundSeq)).toEqual([
        { recovery_plan_id: openPlanId, disposition: 'recovery_pending_operator_catchup' },
        { recovery_plan_id: closedPlanId, disposition: 'recovery_pending_operator_catchup' },
        { recovery_plan_id: closedPlanId, disposition: 'superseded_by_operator_catchup' },
      ]);
      expect(durability.getTurnRecoverySupervisorCounts().openRecoveries).toBe(1);

      expectRefused(t, 'open_disposition_link');
    });

    it('refuses a record that names its own source as recovery owner', () => {
      const t = unknownDeliveryOrphan('owner-self', { corroborate: false });
      // Structural stand-in: finalization always names a separate owner. With no
      // job and no corroboration row, no trigger guards the owner columns.
      db.raw.prepare(`
        UPDATE turn_terminal_records
        SET recovery_owner_logical_turn_id = logical_turn_id,
            recovery_owner_manager_id = manager_id,
            recovery_owner_generation = generation
        WHERE id = ?
      `).run(t.recordId);
      expectRefused(t, 'owner_identity_conflict');
    });

    it('refuses a record whose selected op row is gone', () => {
      const t = unknownDeliveryOrphan('op-gone', { corroborate: false });
      // Structural stand-in: with no job and no corroboration row, no retain
      // trigger keeps the selected op.
      expect(Number(db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(t.opId).changes)).toBe(1);
      expectRefused(t, 'delivery_op_missing');
    });

    it('refuses a record whose source inbound row is gone', () => {
      const t = unknownDeliveryOrphan('inbound-gone');
      // Structural stand-in: with no job and no disposition link, no retain
      // trigger keeps the source inbound. The corroboration does not read it.
      expect(Number(db.raw.prepare('DELETE FROM inbound_events WHERE seq = ?').run(t.inboundSeq).changes)).toBe(1);
      expectRefused(t, 'source_inbound_missing');
    });

    it('refuses a settle plan that exists without its job', () => {
      const t = unknownDeliveryOrphan('plan-only');
      // Structural stand-in: settle writes the plan and the job together.
      db.raw.prepare(`
        INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
        VALUES (?, 'operator', ?, 'stand-in plan without its job', NULL)
      `).run(orphanTransferSettlePlanId(t.recordId), ORPHAN_TRANSFER_SETTLE_ACTOR);
      expectRefused(t, 'settlement_conflict');
    });

    it('refuses a settle-shaped job whose settle plan is missing', () => {
      const t = unknownDeliveryOrphan('job-only');
      const planId = orphanTransferSettlePlanId(t.recordId);
      // Structural stand-in: the job row the settle writes, with no plan row.
      db.raw.prepare(`
        INSERT INTO turn_recovery_jobs (
          terminal_record_id, scope, conversation_key, delivery_jid,
          source_inbound_seq, source_inbound_seq_key,
          source_logical_turn_id, source_manager_id, source_generation, source_message_id,
          owner_logical_turn_id, owner_manager_id, owner_generation,
          assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
          replay_safe, replay_safety_proof_id, sender_jid, sender_name, replay_text,
          is_group, group_name, state, attempt_count, claim_epoch
        )
        SELECT t.id, t.scope, t.conversation_key, t.delivery_jid,
               t.inbound_seq, t.inbound_seq,
               t.logical_turn_id, t.manager_id, t.generation, i.message_id,
               t.recovery_owner_logical_turn_id, t.recovery_owner_manager_id, t.recovery_owner_generation,
               'stand-in-owner-' || t.id, ?, 1,
               0, ?, 'stand-in-sender', NULL, 'stand-in text',
               0, NULL, 'exhausted', 5, 5
        FROM turn_terminal_records t
        JOIN inbound_events i ON i.seq = t.inbound_seq
        WHERE t.id = ?
      `).run(ORPHAN_TRANSFER_SETTLE_ACTOR, planId, t.recordId);
      const before = settleState();

      expect(refusal(t.recordId)).toEqual({
        verdict: 'refused', terminalId: t.recordId, reason: 'settlement_conflict',
      });
      expect(settleState()).toEqual(before);
    });

    it('refuses a selected op whose conversation differs from the record', () => {
      const t = unknownDeliveryOrphan('op-conversation', { corroborate: false });
      // Structural stand-in, as for the chat mismatch above.
      db.raw.prepare(`UPDATE outbound_ops SET conversation_key = 'orphan-settle-elsewhere' WHERE id = ?`)
        .run(t.opId);
      expectRefused(t, 'delivery_identity_mismatch');
    });

    it('refuses a selected op whose source seq differs from the record', () => {
      const t = unknownDeliveryOrphan('op-seq', { corroborate: false });
      const otherSeq = durability.journalInbound(
        'wamid-orphan-settle-op-seq-other', t.conversationKey, `${t.conversationKey}@s.whatsapp.net`, 'agent',
      );
      // Structural stand-in, as for the chat mismatch above.
      db.raw.prepare('UPDATE outbound_ops SET source_inbound_seq = ? WHERE id = ?').run(otherSeq, t.opId);
      expectRefused(t, 'delivery_identity_mismatch');
    });

    it('refuses a source inbound whose conversation differs from the record', () => {
      const t = unknownDeliveryOrphan('inbound-conversation');
      // Structural stand-in, as for the chat mismatch above.
      db.raw.prepare(`UPDATE inbound_events SET conversation_key = 'orphan-settle-elsewhere' WHERE seq = ?`)
        .run(t.inboundSeq);
      expectRefused(t, 'source_inbound_identity_mismatch');
    });
  });

  describe('the write step refuses to leave a partial settle', () => {
    it('refuses a malformed evidence reference before writing anything', () => {
      const t = unknownDeliveryOrphan('bad-ref');
      const settler = new OrphanTransferSettler(db.raw);
      const evaluation = settler.evaluate(t.recordId);
      expect(evaluation.verdict).toBe('eligible');
      const jobs = rowCount('turn_recovery_jobs');
      const plans = rowCount('recovery_plans');

      expect(() => settler.applyWithinCallerTransaction(
        evaluation as EligibleOrphanTransferSettle,
        'not a valid ref',
      )).toThrow('OrphanTransferSettler: evidence reference has an invalid shape');

      expect(rowCount('turn_recovery_jobs')).toBe(jobs);
      expect(rowCount('recovery_plans')).toBe(plans);
      expect(durability.getTurnRecoverySupervisorCounts().orphanTransfers).toBe(1);
    });

    it('throws when the job row is not written, so the caller rolls the plan back', () => {
      const t = unknownDeliveryOrphan('no-job-row');
      const settler = new OrphanTransferSettler(db.raw);
      const evaluation = settler.evaluate(t.recordId);
      expect(evaluation.verdict).toBe('eligible');
      // Structural stand-in for a change after evaluation: the job insert joins
      // the source inbound, so without it the insert selects no row.
      db.raw.prepare('DELETE FROM inbound_events WHERE seq = ?').run(t.inboundSeq);
      const plans = rowCount('recovery_plans');

      db.raw.exec('BEGIN IMMEDIATE');
      let thrown: unknown;
      try {
        settler.applyWithinCallerTransaction(evaluation as EligibleOrphanTransferSettle, EVIDENCE_REF);
      } catch (err) {
        thrown = err;
      }
      db.raw.exec('ROLLBACK');

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('OrphanTransferSettler: the settled recovery job was not written');
      expect(rowCount('recovery_plans')).toBe(plans);
      expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM turn_recovery_jobs WHERE terminal_record_id = ?')
        .get(t.recordId) as { n: number }).n)).toBe(0);
    });
  });

  it('lists only orphan transfers, and a settled one leaves the list', () => {
    const orphan = unknownDeliveryOrphan('listed');
    enqueuedTransfer('not-listed');
    const settler = new OrphanTransferSettler(db.raw);
    expect(settler.orphanTerminalIds()).toEqual([orphan.recordId]);

    settle(orphan.recordId);

    expect(settler.orphanTerminalIds()).toEqual([]);
  });

  it('leaves a NEW orphan visible after an earlier one was settled', () => {
    const first = unknownDeliveryOrphan('first');
    settle(first.recordId);
    unknownDeliveryOrphan('second');

    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({ orphanTransfers: 1, corruptLinks: 1 });
    expect(health().blockingReasons).toContain('turn_recovery_integrity');
  });
});
