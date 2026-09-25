import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';
import {
  classifyRuntimeRecoveryHealth,
  type RuntimeRecoveryHealthInput,
} from '../../src/runtimes/agent/runtime-recovery-health.ts';
import { getTurnRecoveryHealthDetails } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';

const OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-retained',
  managerId: 'manager-recovery-retained',
  generation: 4,
};

describe('corroborated turn recovery retention', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  it('retains an unknown-delivery job without claimability or admission blocking', () => {
    const conversationKey = 'corroborated-retained-conversation';
    const deliveryJid = 'corroborated-retained@g.us';
    const sourceMessageId = 'corroborated-retained-source';
    const inboundSeq = durability.journalInbound(
      sourceMessageId,
      conversationKey,
      deliveryJid,
      'agent',
    );
    const selectedOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'send_text',
      payload: '{"text":"uncertain selected delivery"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(selectedOpId);
    durability.markMaybeSent(selectedOpId, 'transport result unknown');
    db.raw.prepare(
      "UPDATE outbound_ops SET ambiguity_at = datetime('now', '-31 seconds') WHERE id = ?",
    ).run(selectedOpId);

    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey,
        deliveryJid,
        inboundSeq,
        logicalTurnId: 'turn-source-corroborated-retained',
        managerId: 'manager-source',
        generation: 3,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'delivery_unknown', opId: selectedOpId },
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, {
        sourceMessageId,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: 'corroborated-sender@s.whatsapp.net',
        senderName: 'Exact Sender',
        text: 'exact transformed source text',
        isGroup: true,
        groupName: 'Exact Group',
      }),
    });
    const jobId = receipt.recoveryJob!.jobId;

    const corroboratingOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'send_text',
      payload: '{"text":"later echoed delivery"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(corroboratingOpId);
    durability.markSubmitted(corroboratingOpId, 'wa-corroborated-retained');
    durability.markEchoed(corroboratingOpId);

    const selectedBefore = db.raw.prepare(
      'SELECT * FROM outbound_ops WHERE id = ?',
    ).get(selectedOpId);
    const terminalBefore = db.raw.prepare(
      'SELECT * FROM turn_terminal_records WHERE id = ?',
    ).get(receipt.recordId);
    const jobBefore = db.raw.prepare(
      'SELECT * FROM turn_recovery_jobs WHERE id = ?',
    ).get(jobId);

    durability.postConnectRecovery();

    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      pending: 1,
      blockingOutstanding: 0,
      corroboratedRetained: 1,
    });
    expect(durability.getRecoverableTurnRecoveryJobs(OWNER).jobs).toEqual([]);
    expect(durability.getOutstandingTurnRecoveryJobsForSupervisor().jobs).toEqual([]);
    // The three-state admission probe shares the outstanding-for-scope
    // subquery, so corroborated work must not block admission there either.
    expect(durability.getTurnRecoveryAdmissionStateForScope(
      'per_chat',
      conversationKey,
    )).toBe('clear');
    expect(durability.hasOutstandingTurnRecoveryForScope(
      'per_chat',
      conversationKey,
    )).toBe(false);
    expect(() => durability.claimTurnRecoveryJob(jobId, OWNER, {
      claimToken: 'corroborated-retained-claim',
      leaseSeconds: 60,
    })).toThrow();
    expect(db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(selectedOpId))
      .toEqual(selectedBefore);
    expect(db.raw.prepare('SELECT * FROM turn_terminal_records WHERE id = ?').get(receipt.recordId))
      .toEqual(terminalBefore);
    expect(db.raw.prepare('SELECT * FROM turn_recovery_jobs WHERE id = ?').get(jobId))
      .toEqual(jobBefore);
  });

  it('counts a corroborated orphan transfer as retained, never as blocking outstanding work', () => {
    const conversationKey = 'corroborated-orphan-conversation';
    const deliveryJid = 'corroborated-orphan@g.us';
    const sourceMessageId = 'corroborated-orphan-source';
    const inboundSeq = durability.journalInbound(
      sourceMessageId,
      conversationKey,
      deliveryJid,
      'agent',
    );
    const selectedOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'send_text',
      payload: '{"text":"uncertain selected delivery"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(selectedOpId);
    durability.markMaybeSent(selectedOpId, 'transport result unknown');
    db.raw.prepare(
      "UPDATE outbound_ops SET ambiguity_at = datetime('now', '-31 seconds') WHERE id = ?",
    ).run(selectedOpId);
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey,
        deliveryJid,
        inboundSeq,
        logicalTurnId: 'turn-source-corroborated-orphan',
        managerId: 'manager-source',
        generation: 3,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'delivery_unknown', opId: selectedOpId },
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, {
        sourceMessageId,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: 'corroborated-orphan-sender@s.whatsapp.net',
        senderName: 'Exact Sender',
        text: 'exact transformed source text',
        isGroup: true,
        groupName: 'Exact Group',
      }),
    });
    const corroboratingOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'send_text',
      payload: '{"text":"later echoed delivery"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(corroboratingOpId);
    durability.markSubmitted(corroboratingOpId, 'wa-corroborated-orphan');
    durability.markEchoed(corroboratingOpId);
    durability.postConnectRecovery();

    // Orphan the transfer: the terminal record survives without its job row.
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?')
      .run(receipt.recoveryJob!.jobId);
    expect(db.raw.prepare(
      'SELECT COUNT(*) AS count FROM turn_delivery_corroboration WHERE terminal_record_id = ?',
    ).get(receipt.recordId)).toEqual({ count: 1 });

    expect(durability.getTurnRecoveryAdmissionStateForScope(
      'per_chat',
      conversationKey,
    )).toBe('clear');
    const counts = durability.getTurnRecoverySupervisorCounts();
    expect(counts).toMatchObject({
      outstanding: 1,
      orphanTransfers: 1,
      blockingOutstanding: 0,
      corroboratedRetained: 1,
    });
    expect(counts.outstanding).toBe(counts.blockingOutstanding! + counts.corroboratedRetained!);

    // The missing job link is still integrity debt; it is not claimable work.
    const classification = classifyRuntimeRecoveryHealth({
      finalization: { retainedRetries: 0, degradedScopes: 0 } as RuntimeRecoveryHealthInput['finalization'],
      recovery: getTurnRecoveryHealthDetails(durability),
      completedDeliveryIdentity: { unresolvedCount: 0, nextAction: null },
    });
    expect(classification.blockingReasons).toContain('turn_recovery_integrity');
    expect(classification.blockingReasons).not.toContain('turn_recovery_actionable');
    expect(classification.blockingReasons).not.toContain('turn_recovery_unclassified');
  });
});
