import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DurabilityEngine,
  TURN_RECOVERY_MAX_ATTEMPTS,
  TURN_RECOVERY_MAX_TEXT_BYTES,
  type TurnRecoveryJobPersistenceParams,
  type TurnRecoveryOwnerIdentity,
} from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-1',
  managerId: 'manager-recovery',
  generation: 4,
};

const NEXT_OWNER: TurnRecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-restart',
  managerId: 'manager-restarted',
  generation: 5,
};

const THIRD_OWNER: TurnRecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-third',
  managerId: 'manager-third',
  generation: 6,
};

function terminalResult(
  inboundSeq: number,
  suffix: string,
  owner: RecoveryOwnerIdentity = OWNER,
): { result: TurnTerminalResult; owner: RecoveryOwnerIdentity } {
  return {
    result: {
      identity: {
        scope: 'per_chat',
        conversationKey: '15550100001',
        deliveryJid: '15550100001:7@s.whatsapp.net',
        inboundSeq,
        logicalTurnId: `turn-source-${suffix}`,
        managerId: 'manager-source',
        generation: 3,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId: 41 },
    },
    owner,
  };
}

function replayEnvelope(
  suffix: string,
  overrides: Partial<TurnRecoveryReplayEnvelope> = {},
): TurnRecoveryReplayEnvelope {
  return {
    sourceMessageId: `wamid-${suffix}`,
    replaySafe: true,
    senderJid: '15550100002:9@s.whatsapp.net',
    senderName: 'Exact Sender',
    text: `[voice transcript ${suffix}]\nexact transformed text`,
    isGroup: true,
    groupName: 'Exact Group',
    ...overrides,
  };
}

describe('turn recovery job adapter', () => {
  it('captures the exact transformed payload and both complete identities', () => {
    const { result, owner } = terminalResult(41, 'adapter');

    expect(toTurnRecoveryJobPersistence(
      result,
      owner,
      replayEnvelope('adapter'),
    )).toMatchObject({
      scope: 'per_chat',
      conversationKey: '15550100001',
      deliveryJid: '15550100001:7@s.whatsapp.net',
      sourceInboundSeq: 41,
      sourceLogicalTurnId: 'turn-source-adapter',
      sourceManagerId: 'manager-source',
      sourceGeneration: 3,
      sourceMessageId: 'wamid-adapter',
      ownerLogicalTurnId: 'turn-recovery-1',
      ownerManagerId: 'manager-recovery',
      ownerGeneration: 4,
      replaySafe: true,
      replayText: '[voice transcript adapter]\nexact transformed text',
    });
  });

  it('preserves an explicit unsafe marker for durable fail-closed parking', () => {
    const { result, owner } = terminalResult(41, 'adapter-unsafe');

    expect(toTurnRecoveryJobPersistence(
      result,
      owner,
      replayEnvelope('adapter-unsafe', { replaySafe: false }),
    )).toMatchObject({ replaySafe: false, replayText: expect.stringContaining('adapter-unsafe') });
  });

  it('rejects blank, oversized, and non-transfer replay inputs', () => {
    const { result, owner } = terminalResult(41, 'adapter-reject');
    expect(() => toTurnRecoveryJobPersistence(
      result,
      owner,
      replayEnvelope('adapter-reject', { text: ' \n\t' }),
    )).toThrow('nonempty replay text');
    expect(() => toTurnRecoveryJobPersistence(
      result,
      owner,
      replayEnvelope('adapter-reject', {
        text: 'é'.repeat(Math.floor(TURN_RECOVERY_MAX_TEXT_BYTES / 2) + 1),
      }),
    )).toThrow('byte limit');
    expect(() => toTurnRecoveryJobPersistence(
      { ...result, inboundDisposition: 'unfinalized_retry_owned' },
      owner,
      replayEnvelope('adapter-reject'),
    )).toThrow('transferred disposition');
    expect(() => toTurnRecoveryJobPersistence(
      { ...result, deliveryEvidence: { kind: 'none' } },
      owner,
      replayEnvelope('adapter-reject'),
    )).toThrow(/delivery evidence/i);
  });

  it('rejects a synthetic transfer without an existing journaled inbound source', () => {
    const { result, owner } = terminalResult(41, 'adapter-synthetic');

    expect(() => toTurnRecoveryJobPersistence(
      { ...result, identity: { ...result.identity, inboundSeq: null } },
      owner,
      replayEnvelope('adapter-synthetic'),
    )).toThrow('journaled inbound');
  });
});

describe('atomic linked turn recovery jobs', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTransfer(
    suffix: string,
    owner: RecoveryOwnerIdentity = OWNER,
    envelopeOverrides: Partial<TurnRecoveryReplayEnvelope> = {},
    identityOverrides: Partial<TurnTerminalResult['identity']> = {},
  ) {
    const messageId = envelopeOverrides.sourceMessageId ?? `wamid-${suffix}`;
    const conversationKey = identityOverrides.conversationKey ?? '15550100001';
    const deliveryJid = identityOverrides.deliveryJid ?? '15550100001:7@s.whatsapp.net';
    const inboundSeq = durability.journalInbound(
      messageId,
      conversationKey,
      deliveryJid,
      'agent',
    );
    const terminal = terminalResult(inboundSeq, suffix, owner);
    const identity = {
      ...terminal.result.identity,
      ...identityOverrides,
      conversationKey,
      deliveryJid,
      inboundSeq,
    };
    const deliveryOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'text',
      payload: JSON.stringify({ text: `selected delivery ${suffix}` }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
    });
    const result: TurnTerminalResult = {
      ...terminal.result,
      identity,
      deliveryEvidence: { kind: 'enqueued', opId: deliveryOpId },
    };
    const envelope = replayEnvelope(suffix, { sourceMessageId: messageId, ...envelopeOverrides });
    return {
      inboundSeq,
      terminal: { result, owner: terminal.owner },
      envelope,
      params: {
        ...toTurnFinalizationPersistence(result, owner),
        recoveryJob: toTurnRecoveryJobPersistence(result, owner, envelope),
      },
    };
  }

  function selectedDeliveryOpId(transfer: ReturnType<typeof createTransfer>): number {
    const evidence = transfer.terminal.result.deliveryEvidence;
    if (evidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    return evidence.opId;
  }

  it('commits the APPLIED transfer winner and linked exact replay job together', () => {
    const transfer = createTransfer('atomic');

    const receipt = durability.finalizeTurnTerminal(transfer.params);
    const terminal = durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    );
    const job = durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId);

    expect(receipt).toMatchObject({
      applied: true,
      replyGuaranteeDisarmed: false,
      effectiveReplyGuaranteeDisarmed: true,
      recoveryJob: { status: 'durably_queued', applied: true, state: 'pending' },
    });
    expect(terminal).toMatchObject({ reply_guarantee_disarmed: 0 });
    expect(job).toMatchObject({
      terminal_record_id: terminal!.id,
      source_inbound_seq: transfer.inboundSeq,
      source_message_id: 'wamid-atomic',
      source_manager_id: 'manager-source',
      owner_logical_turn_id: OWNER.logicalTurnId,
      assigned_owner_logical_turn_id: OWNER.logicalTurnId,
      replay_safe: 1,
      replay_text: '[voice transcript atomic]\nexact transformed text',
      state: 'pending',
      attempt_count: 0,
      claim_epoch: 0,
    });
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('processing');
  });

  it('parks an unsafe exact envelope under a durable manual owner without claimability', () => {
    const transfer = createTransfer('blocked-unsafe', OWNER, { replaySafe: false });

    const receipt = durability.finalizeTurnTerminal(transfer.params);
    expect(receipt.recoveryJob).toBeDefined();
    const job = durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId);

    expect(receipt).toMatchObject({
      applied: true,
      replyGuaranteeDisarmed: false,
      effectiveReplyGuaranteeDisarmed: true,
      recoveryJob: {
        status: 'durably_blocked',
        applied: true,
        state: 'blocked_unsafe',
      },
    });
    expect(job).toMatchObject({
      replay_safe: 0,
      replay_safety_proof_id: null,
      replay_text: '[voice transcript blocked-unsafe]\nexact transformed text',
      state: 'blocked_unsafe',
      attempt_count: 0,
      claim_epoch: 0,
      assigned_owner_logical_turn_id: OWNER.logicalTurnId,
    });
    expect(() => durability.claimTurnRecoveryJob(job!.id, OWNER, {
      claimToken: 'blocked-claim-token',
      leaseSeconds: 60,
    })).toThrow('blocked unsafe');
    expect(durability.getRecoverableTurnRecoveryJobs(
      OWNER,
      { limit: 10, afterId: 0 },
    ).jobs).toEqual([]);
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      blockedUnsafe: 1,
      pending: 0,
      expiredClaimed: 0,
      exhausted: 0,
    });

    const duplicate = durability.finalizeTurnTerminal(transfer.params);
    expect(duplicate).toMatchObject({
      applied: false,
      effectiveReplyGuaranteeDisarmed: true,
      recoveryJob: {
        status: 'durably_blocked',
        applied: false,
        jobId: job!.id,
      },
    });
  });

  it('requires proof promotion and epoch-fenced reassignment before blocked work is claimable', () => {
    const transfer = createTransfer('blocked-restart', NEXT_OWNER, { replaySafe: false });
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    const restarted = new DurabilityEngine(db);
    const discovered = restarted.getOutstandingTurnRecoveryJobsForSupervisor({
      limit: 10,
      afterId: 0,
    }).jobs;

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      id: queued.jobId,
      state: 'blocked_unsafe',
      assigned_owner_manager_id: NEXT_OWNER.managerId,
    });
    expect(discovered[0]).not.toHaveProperty('claim_token');
    expect(() => db.raw.prepare(
      "UPDATE turn_recovery_jobs SET state = 'pending' WHERE id = ?",
    ).run(queued.jobId)).toThrow();
    expect(() => db.raw.prepare(
      `UPDATE turn_recovery_jobs
       SET state = 'pending', replay_safety_proof_id = ?
       WHERE id = ?`,
    ).run('\t\n\r', queued.jobId)).toThrow();
    expect(() => db.raw.prepare(
      `UPDATE turn_recovery_jobs
       SET state = 'pending', replay_safety_proof_id = ?
       WHERE id = ?`,
    ).run('x'.repeat(2049), queued.jobId)).toThrow();
    expect(() => restarted.reassignBlockedTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
    )).toThrow('epoch fence');
    expect(restarted.reassignBlockedTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    )).toMatchObject({ applied: true, assignedOwner: OWNER, assignmentEpoch: 1 });
    expect(restarted.reassignBlockedTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    )).toMatchObject({ applied: false, assignedOwner: OWNER, assignmentEpoch: 1 });
    expect(() => restarted.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
      { idempotencyProofId: 'proof:wrong-epoch' },
    )).toThrow('epoch fence');
    expect(() => restarted.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
      { idempotencyProofId: '\t\n' },
    )).toThrow('nonempty');

    const promoted = restarted.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
      { idempotencyProofId: 'proof:block-replay-safe:v1' },
    );
    expect(promoted).toMatchObject({ applied: true, state: 'pending' });
    expect(restarted.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
      { idempotencyProofId: 'proof:block-replay-safe:v1' },
    )).toMatchObject({ applied: false, state: 'pending' });
    expect(() => restarted.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
      { idempotencyProofId: 'proof:conflicting' },
    )).toThrow('different idempotency proof');
    expect(restarted.getTurnRecoveryJob(queued.jobId)).toMatchObject({
      replay_safe: 0,
      replay_safety_proof_id: 'proof:block-replay-safe:v1',
      state: 'pending',
      claim_epoch: 0,
    });
    expect(() => db.raw.prepare(
      'UPDATE turn_recovery_jobs SET replay_safety_proof_id = ? WHERE id = ?',
    ).run('proof:raw-replacement', queued.jobId)).toThrow('immutable');
    expect(restarted.finalizeTurnTerminal(transfer.params)).toMatchObject({
      applied: false,
      effectiveReplyGuaranteeDisarmed: true,
      recoveryJob: {
        status: 'durably_queued',
        state: 'pending',
        jobId: queued.jobId,
      },
    });
    expect(restarted.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'promoted-claim-token',
      leaseSeconds: 60,
    })).toMatchObject({ applied: true, claimEpoch: 1 });
  });

  it('rejects stale blocked promotion after an A-to-B-to-A owner cycle', () => {
    const transfer = createTransfer('blocked-aba', OWNER, { replaySafe: false });
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;

    durability.reassignBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      NEXT_OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    );
    durability.reassignBlockedTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
    );
    expect(() => durability.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
      { idempotencyProofId: 'proof:stale-after-aba' },
    )).toThrow('epoch fence');
    expect(durability.promoteBlockedTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 2 },
      { idempotencyProofId: 'proof:fresh-after-aba' },
    )).toMatchObject({ applied: true, assignmentEpoch: 2 });
  });

  it('requires a linked recovery job for transfers and forbids one otherwise', () => {
    const transfer = createTransfer('required');
    expect(() => durability.finalizeTurnTerminal({
      terminal: transfer.params.terminal,
    })).toThrow('requires a recovery job');

    const nonTransfer = {
      ...transfer.params,
      terminal: {
        ...transfer.params.terminal,
        inboundDisposition: 'unfinalized_retry_owned',
        recoveryOwnerLogicalTurnId: null,
        recoveryOwnerManagerId: null,
        recoveryOwnerGeneration: null,
      },
    };
    expect(() => durability.finalizeTurnTerminal(nonTransfer)).toThrow(
      'only valid for a transferred disposition',
    );
  });

  it('rolls back the terminal winner when linked recovery insertion fails', () => {
    const transfer = createTransfer('insert-failure');
    db.raw.exec(`
      CREATE TRIGGER deny_recovery_insert
      BEFORE INSERT ON turn_recovery_jobs
      BEGIN SELECT RAISE(ABORT, 'recovery insert denied'); END
    `);

    expect(() => durability.finalizeTurnTerminal(transfer.params))
      .toThrow('recovery insert denied');
    expect(durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    )).toBeUndefined();
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM turn_recovery_jobs').get())
      .toEqual({ count: 0 });
  });

  it('retains source inbound and selected delivery proof while recovery is outstanding', () => {
    const transfer = createTransfer('retention-proof');
    durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const deliveryOpId = transfer.terminal.result.deliveryEvidence.opId;

    expect(() => db.raw.prepare('DELETE FROM inbound_events WHERE seq = ?')
      .run(transfer.inboundSeq)).toThrow(/outstanding recovery proof/i);
    expect(() => db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?')
      .run(deliveryOpId))
      .toThrow(/outstanding recovery proof/i);
  });

  it('keeps a linked terminal and selected outbound identity immutable', () => {
    const transfer = createTransfer('immutable-proof');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }

    expect(() => db.raw.prepare(
      "UPDATE turn_terminal_records SET scope = 'shared' WHERE id = ?",
    ).run(receipt.recordId)).toThrow(/immutable|recovery/i);
    expect(() => db.raw.prepare(
      "UPDATE outbound_ops SET conversation_key = 'corrupt' WHERE id = ?",
    ).run(selectedDeliveryOpId(transfer))).toThrow(/immutable|recovery/i);
    expect(() => db.raw.prepare(
      "UPDATE inbound_events SET message_id = 'corrupt' WHERE seq = ?",
    ).run(transfer.inboundSeq)).toThrow(/immutable|recovery/i);
  });

  it('rejects raw recovery completion while the source inbound remains open', () => {
    const transfer = createTransfer('raw-completion-open');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;

    expect(() => db.raw.prepare(`
      UPDATE turn_recovery_jobs
      SET state = 'completed',
          attempt_count = 1,
          claim_epoch = 1,
          claim_token = 'raw-completion-token',
          claimed_at = datetime('now'),
          claim_expires_at = datetime('now', '+60 seconds'),
          completed_at = datetime('now'),
          completion_kind = 'worker',
          completion_proof_id = 'raw-completion-proof'
      WHERE id = ?
    `).run(queued.jobId)).toThrow(/source inbound|terminal/i);
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('processing');
  });

  it('rejects raw completed inserts until both proofs are terminal and keeps them terminal', () => {
    const transfer = createTransfer('raw-completion-insert');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    const opId = selectedDeliveryOpId(transfer);
    db.raw.prepare(`
      CREATE TEMP TABLE saved_recovery_job AS
      SELECT * FROM turn_recovery_jobs WHERE id = ?
    `).run(queued.jobId);
    db.raw.prepare(`
      UPDATE saved_recovery_job
      SET state = 'completed',
          attempt_count = 1,
          claim_epoch = 1,
          claim_token = 'raw-completion-insert-token',
          claimed_at = datetime('now'),
          claim_expires_at = datetime('now', '+60 seconds'),
          completed_at = datetime('now'),
          completion_kind = 'worker',
          completion_proof_id = 'raw-completion-insert-proof'
    `).run();
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?').run(queued.jobId);

    expect(() => db.raw.exec(`
      INSERT INTO turn_recovery_jobs SELECT * FROM saved_recovery_job
    `)).toThrow(/source inbound|terminal/i);

    durability.markInboundFailed(transfer.inboundSeq, 'crash_recovery');
    expect(() => db.raw.exec(`
      INSERT INTO turn_recovery_jobs SELECT * FROM saved_recovery_job
    `)).toThrow(/selected delivery|terminal/i);

    durability.markQuarantined(opId);
    expect(() => db.raw.exec(`
      INSERT INTO turn_recovery_jobs SELECT * FROM saved_recovery_job
    `)).not.toThrow();
    expect(() => db.raw.prepare(`
      UPDATE inbound_events SET processing_status = 'processing' WHERE seq = ?
    `).run(transfer.inboundSeq)).toThrow(/must stay terminal/i);
    expect(() => db.raw.prepare(`
      UPDATE outbound_ops SET status = 'pending' WHERE id = ?
    `).run(opId)).toThrow(/must stay terminal/i);
  });

  it('hides a corrupt terminal scope from actionable recovery while keeping it visible', () => {
    const transfer = createTransfer('corrupt-actionable-scope');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    const queued = receipt.recoveryJob!;
    db.raw.exec('DROP TRIGGER IF EXISTS turn_terminal_recovery_envelope_immutable');
    db.raw.prepare(
      "UPDATE turn_terminal_records SET scope = 'shared' WHERE id = ?",
    ).run(receipt.recordId);

    expect(durability.getTurnRecoveryJob(queued.jobId)).toBeUndefined();
    expect(durability.getRecoverableTurnRecoveryJobs(OWNER, { limit: 10, afterId: 0 }).jobs)
      .toEqual([]);
    expect(() => durability.claimTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimToken: 'corrupt-scope-token', leaseSeconds: 60 },
    )).toThrow('does not exist');
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      corruptLinks: 1,
    });
  });

  it.each(['missing', 'message-mismatch', 'already-terminal'] as const)(
    'validates the %s inbound proof even though transfer has no inbound mutation',
    (failure) => {
      const transfer = createTransfer(`inbound-${failure}`);
      if (failure === 'missing') {
        db.raw.prepare('DELETE FROM inbound_events WHERE seq = ?').run(transfer.inboundSeq);
      } else if (failure === 'message-mismatch') {
        db.raw.prepare(
          "UPDATE inbound_events SET message_id = 'different-message' WHERE seq = ?",
        ).run(transfer.inboundSeq);
      } else {
        durability.markInboundComplete(transfer.inboundSeq, 'already-complete');
      }

      expect(() => durability.finalizeTurnTerminal(transfer.params)).toThrow(/inbound|Inbound|message/);
      expect(durability.getTurnTerminal(
        transfer.inboundSeq,
        transfer.terminal.result.identity.logicalTurnId,
        3,
      )).toBeUndefined();
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM turn_recovery_jobs').get())
        .toEqual({ count: 0 });
    },
  );

  it('returns the existing linked receipt only for an exact duplicate transfer', () => {
    const transfer = createTransfer('duplicate');
    const first = durability.finalizeTurnTerminal(transfer.params);
    const duplicate = durability.finalizeTurnTerminal(transfer.params);

    expect(duplicate).toMatchObject({
      applied: false,
      duplicateFinalizeCount: 1,
      effectiveReplyGuaranteeDisarmed: true,
      recoveryJob: {
        status: 'durably_queued',
        applied: false,
        jobId: first.recoveryJob!.jobId,
        duplicateEnqueueCount: 1,
      },
    });

    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    durability.markSending(transfer.terminal.result.deliveryEvidence.opId);
    durability.markSubmitted(
      transfer.terminal.result.deliveryEvidence.opId,
      'wa-duplicate-progressed',
    );
    expect(durability.finalizeTurnTerminal(transfer.params)).toMatchObject({
      applied: false,
      winnerMatchesRequest: true,
      recoveryJob: {
        applied: false,
        jobId: first.recoveryJob!.jobId,
        duplicateEnqueueCount: 2,
      },
    });

    const conflicting = durability.finalizeTurnTerminal({
      ...transfer.params,
      recoveryJob: { ...transfer.params.recoveryJob, replayText: 'conflicting payload' },
    });
    expect(conflicting).toMatchObject({ applied: false, duplicateFinalizeCount: 3 });
    expect(conflicting.winnerMatchesRequest).toBe(false);
    expect(conflicting.effectiveReplyGuaranteeDisarmed).toBe(false);
    expect(conflicting.recoveryJob).toBeUndefined();
    expect(durability.getTurnRecoveryJob(first.recoveryJob!.jobId)?.duplicate_enqueue_count)
      .toBe(2);
    expect(durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    )?.duplicate_finalize_count).toBe(3);
  });

  it('returns no disarm or recovery receipt for a conflicting transfer terminal payload', () => {
    const transfer = createTransfer('conflicting-terminal');
    durability.finalizeTurnTerminal(transfer.params);

    const conflicting = durability.finalizeTurnTerminal({
      ...transfer.params,
      terminal: {
        ...transfer.params.terminal,
        attemptFailureClass: 'rate-limit',
      },
    });

    expect(conflicting).toMatchObject({
      applied: false,
      duplicateFinalizeCount: 1,
      replyGuaranteeDisarmed: false,
      effectiveReplyGuaranteeDisarmed: false,
    });
    expect(conflicting.recoveryJob).toBeUndefined();
    expect(durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    )).toMatchObject({
      attempt_failure_class: 'transient-network',
      duplicate_finalize_count: 1,
    });
  });

  it('does not report a full duplicate match when the linked recovery receipt is missing', () => {
    const transfer = createTransfer('missing-linked-receipt');
    const first = durability.finalizeTurnTerminal(transfer.params);
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?')
      .run(first.recoveryJob!.jobId);

    const duplicate = durability.finalizeTurnTerminal(transfer.params);
    expect(duplicate).toMatchObject({
      applied: false,
      winnerMatchesRequest: false,
      effectiveReplyGuaranteeDisarmed: false,
    });
    expect(duplicate.recoveryJob).toBeUndefined();
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      corruptLinks: 1,
      orphanTransfers: 1,
    });
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', '15550100001'))
      .toBe(true);
  });

  const recoveryMismatchCases: Array<[
    string,
    (job: TurnRecoveryJobPersistenceParams) => TurnRecoveryJobPersistenceParams,
  ]> = [
    ['source message', (job) => ({ ...job, sourceMessageId: 'wrong-message' })],
    ['source manager', (job) => ({ ...job, sourceManagerId: 'wrong-manager' })],
    ['source generation', (job) => ({ ...job, sourceGeneration: 99 })],
    ['conversation', (job) => ({ ...job, conversationKey: 'wrong-conversation' })],
    ['delivery JID', (job) => ({ ...job, deliveryJid: 'wrong@s.whatsapp.net' })],
    ['terminal owner', (job) => ({ ...job, ownerManagerId: 'wrong-owner' })],
  ];

  it.each(recoveryMismatchCases)(
    'rejects mismatched recovery %s before the CAS',
    (_label, mutate) => {
      const transfer = createTransfer(`mismatch-${_label.replaceAll(' ', '-')}`);

      expect(() => durability.finalizeTurnTerminal({
        ...transfer.params,
        recoveryJob: mutate(transfer.params.recoveryJob),
      })).toThrow(/recovery|Recovery/);
      expect(durability.getTurnTerminal(
        transfer.inboundSeq,
        transfer.terminal.result.identity.logicalTurnId,
        3,
      )).toBeUndefined();
    },
  );

  it('rejects transfer recovery when delivery is already echoed', () => {
    const transfer = createTransfer('echoed-transfer');
    const opId = durability.createOutboundOp({
      conversationKey: transfer.terminal.result.identity.conversationKey,
      chatJid: transfer.terminal.result.identity.deliveryJid,
      opType: 'send_text',
      payload: '{"text":"already delivered"}',
      replayPolicy: 'safe',
      sourceInboundSeq: transfer.inboundSeq,
    });
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-echoed-transfer');
    durability.markEchoed(opId);

    expect(() => durability.finalizeTurnTerminal({
      ...transfer.params,
      terminal: {
        ...transfer.params.terminal,
        deliveryKind: 'echoed',
        deliveryOpId: opId,
      },
    })).toThrow('exclusive to a finalized_replied');
    expect(durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    )).toBeUndefined();
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM turn_recovery_jobs').get())
      .toEqual({ count: 0 });
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ is_terminal: 0 });
  });

  it('keeps a durable transfer armed while its delivery remains unknown', () => {
    const transfer = createTransfer('unknown-transfer');
    const opId = durability.createOutboundOp({
      conversationKey: transfer.terminal.result.identity.conversationKey,
      chatJid: transfer.terminal.result.identity.deliveryJid,
      opType: 'send_text',
      payload: '{"text":"uncertain delivery"}',
      replayPolicy: 'safe',
      sourceInboundSeq: transfer.inboundSeq,
    });
    durability.markMaybeSent(opId, 'transport result unknown');

    const receipt = durability.finalizeTurnTerminal({
      ...transfer.params,
      terminal: {
        ...transfer.params.terminal,
        deliveryKind: 'delivery_unknown',
        deliveryOpId: opId,
      },
    });

    expect(receipt).toMatchObject({
      applied: true,
      replyGuaranteeDisarmed: false,
      effectiveReplyGuaranteeDisarmed: false,
      recoveryJob: { status: 'durably_queued' },
    });
    expect(durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    )).toMatchObject({ reply_guarantee_disarmed: 0 });
  });

  it('rejects a recovery owner identical to the source identity', () => {
    const sourceOwner: RecoveryOwnerIdentity = {
      logicalTurnId: 'turn-source-same-owner',
      managerId: 'manager-source',
      generation: 3,
    };
    const transfer = createTransfer('same-owner', sourceOwner);

    expect(() => durability.finalizeTurnTerminal(transfer.params))
      .toThrow('source and owner identities must differ');
  });

  it('schema rejects assigning recovery ownership back to the source tuple', () => {
    const transfer = createTransfer('raw-source-owner');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;

    expect(() => db.raw.prepare(
      `UPDATE turn_recovery_jobs
       SET assigned_owner_logical_turn_id = source_logical_turn_id,
           assigned_owner_manager_id = source_manager_id,
           assigned_owner_generation = source_generation,
           assignment_epoch = assignment_epoch + 1
       WHERE id = ?`,
    ).run(queued.jobId)).toThrow('turn_recovery_owner_separation');
    expect(() => db.raw.prepare(
      `UPDATE turn_recovery_jobs
       SET assigned_owner_logical_turn_id = ?,
           assigned_owner_manager_id = ?,
           assigned_owner_generation = ?
       WHERE id = ?`,
    ).run(
      THIRD_OWNER.logicalTurnId,
      THIRD_OWNER.managerId,
      THIRD_OWNER.generation,
      queued.jobId,
    )).toThrow('assignment epoch');
    expect(() => db.raw.prepare(
      'UPDATE turn_recovery_jobs SET assignment_epoch = 7 WHERE id = ?',
    ).run(queued.jobId)).toThrow('assignment epoch');
  });

  it.each([
    ['replay safety', (job: TurnRecoveryJobPersistenceParams) => ({
      ...job,
      replaySafe: 1 as never,
    })],
    ['group flag', (job: TurnRecoveryJobPersistenceParams) => ({
      ...job,
      isGroup: 1 as never,
    })],
    ['replay text', (job: TurnRecoveryJobPersistenceParams) => ({
      ...job,
      replayText: 42 as never,
    })],
  ])('rejects a non-primitive recovery %s before the CAS', (_label, mutate) => {
    const transfer = createTransfer(`primitive-${_label.replaceAll(' ', '-')}`);

    expect(() => durability.finalizeTurnTerminal({
      ...transfer.params,
      recoveryJob: mutate(transfer.params.recoveryJob),
    })).toThrow(/Recovery/);
    expect(durability.getTurnTerminal(
      transfer.inboundSeq,
      transfer.terminal.result.identity.logicalTurnId,
      3,
    )).toBeUndefined();
  });

  it.each([
    'conversation_key',
    'delivery_jid',
    'source_logical_turn_id',
    'source_manager_id',
    'source_message_id',
    'owner_logical_turn_id',
    'owner_manager_id',
    'assigned_owner_logical_turn_id',
    'assigned_owner_manager_id',
    'sender_jid',
  ])('schema rejects control-whitespace-only required identity %s', (column) => {
    const transfer = createTransfer(`blank-${column}`);
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    expect(receipt.recoveryJob).toBeDefined();
    const jobId = receipt.recoveryJob!.jobId;

    expect(() => db.raw.prepare(
      `UPDATE turn_recovery_jobs SET ${column} = ? WHERE id = ?`,
    ).run('\t\n\r', jobId)).toThrow();
  });

  it('rejects blank, oversized, and raw safety downgrades at core and schema boundaries', () => {
    const blank = createTransfer('blank');
    expect(() => durability.finalizeTurnTerminal({
      ...blank.params,
      recoveryJob: { ...blank.params.recoveryJob, replayText: ' \n\t' },
    })).toThrow('nonempty replay text');

    const valid = createTransfer('schema-payload');
    const receipt = durability.finalizeTurnTerminal(valid.params);
    expect(receipt.recoveryJob).toBeDefined();
    const jobId = receipt.recoveryJob!.jobId;
    expect(() => db.raw.prepare(
      'UPDATE turn_recovery_jobs SET replay_safe = 0 WHERE id = ?',
    ).run(jobId)).toThrow();
    expect(() => db.raw.prepare(
      'UPDATE turn_recovery_jobs SET replay_text = ? WHERE id = ?',
    ).run('x'.repeat(TURN_RECOVERY_MAX_TEXT_BYTES + 1), jobId)).toThrow();
    expect(() => db.raw.prepare(
      'UPDATE turn_recovery_jobs SET replay_text = ? WHERE id = ?',
    ).run('different but otherwise valid exact payload', jobId)).toThrow('immutable');
    expect(durability.getTurnRecoveryJob(jobId)?.replay_text)
      .toBe(valid.params.recoveryJob.replayText);
  });

  it('uses a durable owner fence for claim and completion', () => {
    const transfer = createTransfer('claim');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;

    const claimOptions = { claimToken: 'claim-token-primary', leaseSeconds: 60 };
    const claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, claimOptions);
    const repeated = durability.claimTurnRecoveryJob(queued.jobId, OWNER, claimOptions);

    expect(claim).toMatchObject({
      applied: true,
      state: 'claimed',
      claimEpoch: 1,
      attemptCount: 1,
      claimToken: expect.any(String),
      claimExpiresAt: expect.any(String),
    });
    expect(repeated).toMatchObject({
      applied: false,
      claimEpoch: claim.claimEpoch,
      claimToken: claim.claimToken,
    });
    expect(() => durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'claim-token-loser',
      leaseSeconds: 60,
    })).toThrow('another claim token');
    expect(durability.getTurnRecoveryJob(queued.jobId)).not.toHaveProperty('claim_token');
    expect(() => durability.completeTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimToken: 'wrong-token', claimEpoch: claim.claimEpoch },
    )).toThrow('claim fence');
    expect(() => durability.completeTurnRecoveryJob(
      queued.jobId,
      OWNER,
      { claimToken: claim.claimToken, claimEpoch: claim.claimEpoch + 1 },
    )).toThrow('claim fence');

    durability.markInboundFailed(transfer.inboundSeq, 'crash_recovery');
    durability.markQuarantined(selectedDeliveryOpId(transfer));
    expect(durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toMatchObject({ applied: true, state: 'completed' });
    expect(durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toMatchObject({ applied: false, state: 'completed' });
  });

  it('refuses to complete a recovery job while its source inbound remains open', () => {
    const transfer = createTransfer('open-source');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    const claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'open-source-claim',
      leaseSeconds: 60,
    });

    expect(() => durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toThrow(/source inbound.*terminal/i);
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('processing');
    expect(durability.getTurnRecoveryJob(queued.jobId)?.state).toBe('claimed');
  });

  it('refuses worker completion until the selected delivery has a terminal outcome', () => {
    const transfer = createTransfer('open-delivery');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    const claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'open-delivery-claim',
      leaseSeconds: 60,
    });
    durability.markInboundFailed(transfer.inboundSeq, 'crash_recovery');

    expect(() => durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toThrow(/selected delivery.*terminal|terminal.*selected delivery/i);
    durability.markQuarantined(opId);
    expect(durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toMatchObject({ applied: true, state: 'completed' });
  });

  it('settles the source inbound and pending recovery job when selected delivery echoes', () => {
    const transfer = createTransfer('echo-settlement');
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-echo-settlement');
    const result = {
      ...transfer.terminal.result,
      deliveryEvidence: { kind: 'flushed' as const, opId },
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, transfer.terminal.owner),
      recoveryJob: toTurnRecoveryJobPersistence(
        result,
        transfer.terminal.owner,
        transfer.envelope,
      ),
    });

    expect(durability.matchEcho('wa-echo-settlement')).toBe(true);
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('complete');
    expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)).toMatchObject({
      state: 'completed',
      completed_at: expect.any(String),
    });
    expect(() => durability.markEchoed(opId)).not.toThrow();
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('complete');
    expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)?.state).toBe('completed');
  });

  it('preserves the first echoed timestamp across idempotent echo observations', () => {
    const transfer = createTransfer('echo-first-timestamp');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-echo-first-timestamp');
    durability.markEchoed(opId);
    db.raw.prepare("UPDATE outbound_ops SET echoed_at = '2001-02-03 04:05:06' WHERE id = ?")
      .run(opId);

    durability.markEchoed(opId);
    expect(db.raw.prepare('SELECT echoed_at FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ echoed_at: '2001-02-03 04:05:06' });
    expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)?.state).toBe('completed');
  });

  it('finishes a partial echoed settlement when only the recovery job remains open', () => {
    const transfer = createTransfer('echo-partial-job');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-echo-partial-job');
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'complete', completed_at = datetime('now'),
          terminal_reason = 'response_echoed'
      WHERE seq = ?
    `).run(transfer.inboundSeq);

    expect(durability.matchEcho('wa-echo-partial-job')).toBe(true);
    expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)).toMatchObject({
      state: 'completed',
    });
  });

  it('records a late echo after worker completion without rolling back delivery truth', () => {
    const transfer = createTransfer('echo-after-worker');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-echo-after-worker');
    const claim = durability.claimTurnRecoveryJob(receipt.recoveryJob!.jobId, OWNER, {
      claimToken: 'echo-after-worker-claim',
      leaseSeconds: 60,
    });
    durability.markInboundFailed(transfer.inboundSeq, 'crash_recovery');
    durability.markQuarantined(opId);
    durability.completeTurnRecoveryJob(receipt.recoveryJob!.jobId, OWNER, claim);

    expect(durability.matchEcho('wa-echo-after-worker')).toBe(true);
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ status: 'echoed' });
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('failed');
    expect(db.raw.prepare(`
      SELECT state, completion_kind, echo_conflict_at
      FROM turn_recovery_jobs WHERE id = ?
    `).get(receipt.recoveryJob!.jobId)).toMatchObject({
      state: 'completed',
      completion_kind: 'worker',
      echo_conflict_at: expect.any(String),
    });
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 0,
      echoConflicts: 1,
    });
  });

  it('settles a selected delivery that was already echoed before restart recovery', () => {
    const transfer = createTransfer('echo-restart-gap');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    db.raw.prepare(`
      UPDATE outbound_ops
      SET status = 'echoed', echoed_at = datetime('now')
      WHERE id = ?
    `).run(opId);

    const restarted = new DurabilityEngine(db);
    restarted.preConnectRecovery();
    expect(db.raw.prepare(`
      SELECT processing_status, terminal_reason
      FROM inbound_events WHERE seq = ?
    `).get(transfer.inboundSeq)).toEqual({
      processing_status: 'complete',
      terminal_reason: 'response_echoed',
    });
    expect(restarted.getTurnRecoveryJob(receipt.recoveryJob!.jobId)?.state).toBe('completed');
  });

  it.each(['pending', 'failed'] as const)(
    'records delivery truth and a durable conflict when the source inbound is already %s',
    (sourceState) => {
      const transfer = createTransfer(`echo-source-${sourceState}`);
      const receipt = durability.finalizeTurnTerminal(transfer.params);
      if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
        throw new Error('test transfer requires selected delivery evidence');
      }
      const opId = transfer.terminal.result.deliveryEvidence.opId;
      durability.markSending(opId);
      durability.markSubmitted(opId, `wa-echo-source-${sourceState}`);
      if (sourceState === 'pending') {
        db.raw.prepare(
          "UPDATE inbound_events SET processing_status = 'pending' WHERE seq = ?",
        ).run(transfer.inboundSeq);
      } else {
        durability.markInboundFailed(transfer.inboundSeq, 'crash_recovery');
      }

      expect(durability.matchEcho(`wa-echo-source-${sourceState}`)).toBe(true);
      expect(durability.getOutboundByStatus('echoed').map((op) => op.id)).toContain(opId);
      expect(durability.getInboundStatus(transfer.inboundSeq)).toBe(sourceState);
      expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)).toMatchObject({
        state: 'pending',
        echo_conflict_at: expect.any(String),
        echo_conflict_reason: 'open_job_source_not_echo_settleable',
      });
    },
  );

  it('rolls back the outbound echo when linked recovery settlement fails', () => {
    const transfer = createTransfer('echo-rollback');
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    const opId = transfer.terminal.result.deliveryEvidence.opId;
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-echo-rollback');
    const result = {
      ...transfer.terminal.result,
      deliveryEvidence: { kind: 'flushed' as const, opId },
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, transfer.terminal.owner),
      recoveryJob: toTurnRecoveryJobPersistence(
        result,
        transfer.terminal.owner,
        transfer.envelope,
      ),
    });
    db.raw.exec(`
      CREATE TRIGGER deny_recovery_echo_completion
      BEFORE UPDATE OF state ON turn_recovery_jobs
      WHEN NEW.state = 'completed'
      BEGIN SELECT RAISE(ABORT, 'recovery echo completion denied'); END
    `);

    expect(() => durability.matchEcho('wa-echo-rollback'))
      .toThrow('recovery echo completion denied');
    expect(durability.getOutboundByStatus('submitted').map((op) => op.id)).toContain(opId);
    expect(durability.getInboundStatus(transfer.inboundSeq)).toBe('processing');
    expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)?.state).toBe('pending');
  });

  it('requeues with bounded attempts/backoff and fences every later claim epoch', () => {
    const transfer = createTransfer('retry');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    let claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'retry-token-1',
      leaseSeconds: 60,
    });
    const firstFence = { claimToken: claim.claimToken, claimEpoch: claim.claimEpoch };

    expect(durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 30))
      .toMatchObject({ applied: true, state: 'pending', attemptCount: 1 });
    expect(durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 30))
      .toMatchObject({ applied: false, state: 'pending', attemptCount: 1 });
    expect(durability.getTurnRecoveryJob(queued.jobId))
      .not.toHaveProperty('last_requeue_claim_token_hash');
    expect(() => durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 31))
      .toThrow('different backoff');
    expect(() => durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'retry-token-during-backoff',
      leaseSeconds: 60,
    }))
      .toThrow('backoff');
    db.raw.prepare(
      "UPDATE turn_recovery_jobs SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(queued.jobId);

    claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'retry-token-2',
      leaseSeconds: 60,
    });
    expect(claim).toMatchObject({ claimEpoch: 2, attemptCount: 2 });
    expect(claim.claimToken).not.toBe(firstFence.claimToken);
    expect(() => durability.completeTurnRecoveryJob(queued.jobId, OWNER, firstFence))
      .toThrow('claim fence');

    while (claim.attemptCount < TURN_RECOVERY_MAX_ATTEMPTS) {
      durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 0);
      claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
        claimToken: `retry-token-${claim.attemptCount + 1}`,
        leaseSeconds: 60,
      });
    }
    expect(durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 0))
      .toMatchObject({
        applied: true,
        state: 'exhausted',
        attemptCount: TURN_RECOVERY_MAX_ATTEMPTS,
      });
    expect(durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 0))
      .toMatchObject({
        applied: false,
        state: 'exhausted',
        attemptCount: TURN_RECOVERY_MAX_ATTEMPTS,
      });
    expect(() => durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'retry-token-exhausted',
      leaseSeconds: 60,
    }))
      .toThrow('exhausted');
  });

  it('atomically recovers stale claims and rejects the stale fence', () => {
    const transfer = createTransfer('stale');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    const claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'stale-token-1',
      leaseSeconds: 60,
    });
    db.raw.prepare(
      "UPDATE turn_recovery_jobs SET claim_expires_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(queued.jobId);

    expect(() => durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: claim.claimToken,
      leaseSeconds: 60,
    })).toThrow('lease has expired');
    expect(() => durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toThrow('claim fence');
    expect(() => durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 0))
      .toThrow('claim fence');
    expect(() => durability.renewTurnRecoveryClaim(
      queued.jobId,
      OWNER,
      claim,
      { leaseSeconds: 60 },
    )).toThrow('stale or expired');
    expect(durability.recoverStaleTurnRecoveryJobs(50))
      .toEqual({ requeued: 1, exhausted: 0 });
    expect(() => durability.completeTurnRecoveryJob(queued.jobId, OWNER, claim))
      .toThrow('claim fence');
    expect(durability.getTurnRecoveryJob(queued.jobId)).toMatchObject({
      state: 'pending',
    });
    expect(db.raw.prepare('SELECT claim_token FROM turn_recovery_jobs WHERE id = ?').get(queued.jobId))
      .toEqual({ claim_token: null });
  });

  it('exhausts an expired claim at the attempt cap during stale recovery', () => {
    const transfer = createTransfer('stale-cap');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    let claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'stale-cap-token-1',
      leaseSeconds: 60,
    });
    while (claim.attemptCount < TURN_RECOVERY_MAX_ATTEMPTS) {
      durability.requeueTurnRecoveryJob(queued.jobId, OWNER, claim, 0);
      claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
        claimToken: `stale-cap-token-${claim.attemptCount + 1}`,
        leaseSeconds: 60,
      });
    }
    db.raw.prepare(
      "UPDATE turn_recovery_jobs SET claim_expires_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(queued.jobId);

    expect(durability.recoverStaleTurnRecoveryJobs(50))
      .toEqual({ requeued: 0, exhausted: 1 });
    expect(durability.getTurnRecoveryJob(queued.jobId)).toMatchObject({
      state: 'exhausted',
      attempt_count: TURN_RECOVERY_MAX_ATTEMPTS,
    });
    expect(durability.getOutstandingTurnRecoveryJobsForSupervisor({
      limit: 10,
      afterId: 0,
    }).jobs).toEqual([
      expect.objectContaining({ id: queued.jobId, state: 'exhausted' }),
    ]);
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      blockedUnsafe: 0,
      pending: 0,
      expiredClaimed: 0,
      exhausted: 1,
    });
    expect(() => durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      NEXT_OWNER,
      {
        claimEpoch: TURN_RECOVERY_MAX_ATTEMPTS,
        assignmentEpoch: 0,
      },
    )).toThrow('pending');
  });

  it('renews only the current unexpired fence and prevents premature stale recovery', () => {
    const transfer = createTransfer('renew');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;
    const claim = durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'renew-token-1',
      leaseSeconds: 30,
    });

    const renewed = durability.renewTurnRecoveryClaim(
      queued.jobId,
      OWNER,
      claim,
      { leaseSeconds: 120 },
    );
    expect(renewed).toMatchObject({ applied: true, claimEpoch: 1 });
    expect(renewed.claimExpiresAt >= claim.claimExpiresAt).toBe(true);
    expect(durability.recoverStaleTurnRecoveryJobs(50))
      .toEqual({ requeued: 0, exhausted: 0 });
    expect(() => durability.renewTurnRecoveryClaim(
      queued.jobId,
      OWNER,
      { claimToken: 'wrong-renew-token', claimEpoch: claim.claimEpoch },
      { leaseSeconds: 60 },
    )).toThrow('claim fence');
    expect(() => durability.renewTurnRecoveryClaim(
      queued.jobId,
      OWNER,
      claim,
      { leaseSeconds: 301 },
    )).toThrow('between 1 and 300');
  });

  it('reassigns only pending work at the expected epoch before a restart can claim', () => {
    const transfer = createTransfer('reassign');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;

    expect(() => durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      NEXT_OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
    )).toThrow('pending epoch fence');
    expect(durability.getTurnRecoveryJob(queued.jobId)).toMatchObject({
      assigned_owner_logical_turn_id: OWNER.logicalTurnId,
      claim_epoch: 0,
      assignment_epoch: 0,
    });
    expect(durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      NEXT_OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    )).toMatchObject({ applied: true, assignedOwner: NEXT_OWNER, assignmentEpoch: 1 });
    expect(durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      NEXT_OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    )).toMatchObject({ applied: false, assignedOwner: NEXT_OWNER, assignmentEpoch: 1 });
    expect(() => durability.claimTurnRecoveryJob(queued.jobId, OWNER, {
      claimToken: 'old-owner-token',
      leaseSeconds: 60,
    }))
      .toThrow('assigned recovery owner');
    expect(durability.claimTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      { claimToken: 'restarted-owner-token', leaseSeconds: 60 },
    )).toMatchObject({ applied: true, claimEpoch: 1 });
    expect(() => durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      OWNER,
      { claimEpoch: 1, assignmentEpoch: 1 },
    )).toThrow('pending');
  });

  it('rejects a stale A-to-C reassignment after an A-to-B-to-A owner cycle', () => {
    const transfer = createTransfer('reassign-aba');
    const queued = durability.finalizeTurnTerminal(transfer.params).recoveryJob!;

    expect(durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      NEXT_OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    )).toMatchObject({ applied: true, assignmentEpoch: 1 });
    expect(durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      NEXT_OWNER,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 1 },
    )).toMatchObject({ applied: true, assignmentEpoch: 2 });
    expect(() => durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      THIRD_OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
    )).toThrow('epoch fence');
    expect(durability.reassignPendingTurnRecoveryJob(
      queued.jobId,
      OWNER,
      THIRD_OWNER,
      { claimEpoch: 0, assignmentEpoch: 2 },
    )).toMatchObject({ applied: true, assignmentEpoch: 3 });
  });

  it('uses resettable scan-cycle cursors so lower-ID backoff work cannot starve', () => {
    const first = createTransfer('page-1');
    const second = createTransfer('page-2');
    const other = createTransfer('page-other', NEXT_OWNER);
    const firstId = durability.finalizeTurnTerminal(first.params).recoveryJob!.jobId;
    const secondId = durability.finalizeTurnTerminal(second.params).recoveryJob!.jobId;
    durability.finalizeTurnTerminal(other.params);
    const firstClaim = durability.claimTurnRecoveryJob(firstId, OWNER, {
      claimToken: 'page-token-1',
      leaseSeconds: 60,
    });
    durability.requeueTurnRecoveryJob(firstId, OWNER, firstClaim, 600);

    const firstPage = durability.getRecoverableTurnRecoveryJobs(
      OWNER,
      { limit: 1, afterId: 0 },
    );
    expect(firstPage).toMatchObject({
      scanComplete: false,
      nextCursor: firstId,
    });
    expect(firstPage.jobs.map((job) => job.id)).toEqual([firstId]);
    const secondPage = durability.getRecoverableTurnRecoveryJobs(
      OWNER,
      { limit: 1, afterId: firstPage.nextCursor! },
    );
    expect(secondPage).toMatchObject({ scanComplete: true, nextCursor: null });
    expect(secondPage.jobs.map((job) => job.id)).toEqual([secondId]);

    db.raw.prepare(
      "UPDATE turn_recovery_jobs SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(firstId);
    const nextScan = durability.getRecoverableTurnRecoveryJobs(
      OWNER,
      { limit: 1, afterId: secondPage.nextCursor ?? 0 },
    );
    expect(nextScan.jobs.map((job) => job.id)).toEqual([firstId]);
    expect(durability.getRecoverableTurnRecoveryJobs(NEXT_OWNER, { limit: 10, afterId: 0 }).jobs)
      .toHaveLength(1);
  });

  it('lets a supervisor discover pending and expired work across random owners without tokens', () => {
    const pending = createTransfer('supervisor-pending');
    const expired = createTransfer('supervisor-expired', NEXT_OWNER);
    const live = createTransfer('supervisor-live');
    const completed = createTransfer('supervisor-completed', NEXT_OWNER);
    const pendingId = durability.finalizeTurnTerminal(pending.params).recoveryJob!.jobId;
    const expiredId = durability.finalizeTurnTerminal(expired.params).recoveryJob!.jobId;
    const liveId = durability.finalizeTurnTerminal(live.params).recoveryJob!.jobId;
    const completedId = durability.finalizeTurnTerminal(completed.params).recoveryJob!.jobId;
    durability.claimTurnRecoveryJob(expiredId, NEXT_OWNER, {
      claimToken: 'supervisor-expired-token',
      leaseSeconds: 60,
    });
    db.raw.prepare(
      "UPDATE turn_recovery_jobs SET claim_expires_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(expiredId);
    durability.claimTurnRecoveryJob(liveId, OWNER, {
      claimToken: 'supervisor-live-token',
      leaseSeconds: 60,
    });
    const completedClaim = durability.claimTurnRecoveryJob(completedId, NEXT_OWNER, {
      claimToken: 'supervisor-completed-token',
      leaseSeconds: 60,
    });
    durability.markInboundFailed(completed.inboundSeq, 'crash_recovery');
    durability.markQuarantined(selectedDeliveryOpId(completed));
    durability.completeTurnRecoveryJob(completedId, NEXT_OWNER, completedClaim);

    const page = durability.getOutstandingTurnRecoveryJobsForSupervisor({
      limit: 10,
      afterId: 0,
    });
    expect(page.jobs.map((job) => job.id)).toEqual([pendingId, expiredId]);
    expect(page).toMatchObject({ nextCursor: null, scanComplete: true });
    expect(page.jobs[1]).toMatchObject({
      state: 'claimed',
      claim_epoch: 1,
      assigned_owner_logical_turn_id: NEXT_OWNER.logicalTurnId,
      assigned_owner_manager_id: NEXT_OWNER.managerId,
      assigned_owner_generation: NEXT_OWNER.generation,
    });
    expect(page.jobs.every((job) => !('claim_token' in job))).toBe(true);
    expect(page.jobs.map((job) => job.id)).not.toContain(liveId);
    expect(page.jobs.map((job) => job.id)).not.toContain(completedId);
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 3,
      blockedUnsafe: 0,
      pending: 1,
      liveClaimed: 1,
      expiredClaimed: 1,
      exhausted: 0,
      quarantinedDelivery: 0,
      corruptLinks: 0,
    });

    db.raw.prepare(
      "UPDATE turn_recovery_jobs SET claim_expires_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(liveId);
    const nextScan = durability.getOutstandingTurnRecoveryJobsForSupervisor({
      limit: 10,
      afterId: page.nextCursor ?? 0,
    });
    expect(nextScan.jobs.map((job) => job.id)).toEqual([pendingId, expiredId, liveId]);
  });

  it('reports outstanding recovery by exact per-chat scope and whole global scope', () => {
    const perChat = createTransfer('scope-per-chat');
    const shared = createTransfer(
      'scope-shared',
      OWNER,
      {},
      { scope: 'shared', conversationKey: '__global__' },
    );
    const singleton = createTransfer(
      'scope-singleton',
      OWNER,
      {},
      { scope: 'singleton', conversationKey: '__global__' },
    );
    const perChatJob = durability.finalizeTurnTerminal(perChat.params).recoveryJob!;
    durability.finalizeTurnTerminal(shared.params);
    durability.finalizeTurnTerminal(singleton.params);

    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', '15550100001')).toBe(true);
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', 'different-chat')).toBe(false);
    expect(durability.hasOutstandingTurnRecoveryForScope('shared', 'any-chat')).toBe(true);
    expect(durability.hasOutstandingTurnRecoveryForScope('singleton', 'any-chat')).toBe(true);

    const claim = durability.claimTurnRecoveryJob(perChatJob.jobId, OWNER, {
      claimToken: 'scope-completion-claim',
      leaseSeconds: 60,
    });
    expect(durability.hasOutstandingTurnRecoveryForScope(
      'per_chat',
      '15550100001',
    )).toBe(true);
    durability.markInboundFailed(perChat.inboundSeq, 'crash_recovery');
    durability.markQuarantined(selectedDeliveryOpId(perChat));
    durability.completeTurnRecoveryJob(perChatJob.jobId, OWNER, claim);
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', '15550100001')).toBe(false);
  });

  it('does not let terminal recovery dispositions block future turns', () => {
    const blocked = createTransfer(
      'scope-blocked-terminal',
      OWNER,
      { replaySafe: false },
      { conversationKey: 'blocked-terminal-chat' },
    );
    const exhausted = createTransfer(
      'scope-exhausted-terminal',
      OWNER,
      {},
      { conversationKey: 'exhausted-terminal-chat' },
    );
    const blockedJob = durability.finalizeTurnTerminal(blocked.params).recoveryJob!;
    const exhaustedJob = durability.finalizeTurnTerminal(exhausted.params).recoveryJob!;

    let claim = durability.claimTurnRecoveryJob(exhaustedJob.jobId, OWNER, {
      claimToken: 'scope-exhausted-token-1',
      leaseSeconds: 60,
    });
    while (claim.attemptCount < TURN_RECOVERY_MAX_ATTEMPTS) {
      durability.requeueTurnRecoveryJob(exhaustedJob.jobId, OWNER, claim, 0);
      claim = durability.claimTurnRecoveryJob(exhaustedJob.jobId, OWNER, {
        claimToken: `scope-exhausted-token-${claim.attemptCount + 1}`,
        leaseSeconds: 60,
      });
    }
    durability.requeueTurnRecoveryJob(exhaustedJob.jobId, OWNER, claim, 0);

    const blockedBefore = db.raw.prepare(
      'SELECT * FROM turn_recovery_jobs WHERE id = ?',
    ).get(blockedJob.jobId);

    expect(durability.hasOutstandingTurnRecoveryForScope(
      'per_chat',
      'blocked-terminal-chat',
    )).toBe(false);
    expect(durability.hasOutstandingTurnRecoveryForScope(
      'per_chat',
      'exhausted-terminal-chat',
    )).toBe(false);
    expect(db.raw.prepare(
      'SELECT * FROM turn_recovery_jobs WHERE id = ?',
    ).get(blockedJob.jobId)).toEqual(blockedBefore);
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      blockedUnsafe: 1,
      exhausted: 1,
    });
  });

  it('keeps a quarantined selected delivery visible in supervisor health', () => {
    const transfer = createTransfer('health-quarantined');
    durability.finalizeTurnTerminal(transfer.params);
    if (transfer.terminal.result.deliveryEvidence.kind === 'none') {
      throw new Error('test transfer requires selected delivery evidence');
    }
    durability.markQuarantined(transfer.terminal.result.deliveryEvidence.opId);

    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      pending: 1,
      quarantinedDelivery: 1,
      corruptLinks: 0,
    });
  });

  it('never exposes or claims a job whose terminal link was orphaned', () => {
    const transfer = createTransfer('orphan');
    const receipt = durability.finalizeTurnTerminal(transfer.params);
    db.raw.exec('PRAGMA foreign_keys = OFF');
    db.raw.prepare('DELETE FROM turn_terminal_records WHERE id = ?').run(receipt.recordId);
    db.raw.exec('PRAGMA foreign_keys = ON');

    expect(durability.getTurnRecoveryJob(receipt.recoveryJob!.jobId)).toBeUndefined();
    expect(durability.getRecoverableTurnRecoveryJobs(OWNER, { limit: 10, afterId: 0 }).jobs)
      .toEqual([]);
    expect(() => durability.claimTurnRecoveryJob(
      receipt.recoveryJob!.jobId,
      OWNER,
      { claimToken: 'orphan-token', leaseSeconds: 60 },
    )).toThrow('does not exist');
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      corruptLinks: 1,
    });
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', '15550100001')).toBe(true);
  });
});
