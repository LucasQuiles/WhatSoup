import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { TurnRecoveryOwnerIdentity } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

/**
 * ② of the turn-recovery continuity work
 * (docs/turn-recovery-continuity-reconciler.md): the supervisor counts gauge
 * must split `blockedUnsafe` into synthetic / superseded / genuinely-stranded
 * so the elevated backlog stops paging on residue and only real, possibly
 * unanswered user turns stay actionable. `synthetic + superseded + stranded
 * === blockedUnsafe` is a structural invariant asserted on real rows.
 */
describe('turn-recovery blocked-unsafe actionability split', () => {
  let db: Database;
  let durability: DurabilityEngine;

  const OWNER: TurnRecoveryOwnerIdentity = {
    logicalTurnId: 'split-owner-turn',
    managerId: 'split-manager',
    generation: 1,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  function transferFor(
    suffix: string,
    messageId: string,
    conversationKey: string,
  ): { params: Parameters<DurabilityEngine['finalizeTurnTerminal']>[0]; inboundSeq: number } {
    const deliveryJid = `${conversationKey}:1@g.us`;
    const inboundSeq = durability.journalInbound(messageId, conversationKey, deliveryJid, 'agent');
    const identity: TurnIdentity = {
      scope: 'per_chat',
      conversationKey,
      deliveryJid,
      inboundSeq,
      logicalTurnId: `turn-${suffix}`,
      managerId: 'split-manager',
      generation: 1,
    };
    const opId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'text',
      payload: JSON.stringify({ text: `selected ${suffix}` }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
    });
    const result: TurnTerminalResult = {
      identity,
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId },
    };
    const envelope: TurnRecoveryReplayEnvelope = {
      sourceMessageId: messageId,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: false, // parks as blocked_unsafe at insert, like the live backlog
      senderJid: '15550100001:7@s.whatsapp.net',
      senderName: 'Split Fixture',
      text: `blocked fixture ${suffix}`,
      isGroup: false,
    };
    return {
      params: {
        ...toTurnFinalizationPersistence(result, OWNER),
        recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, envelope),
      },
      inboundSeq,
    };
  }

  it('classifies parked jobs into synthetic / superseded / stranded with an exact-sum invariant', () => {
    // Synthetic self-turn (agentjob-% source): synthetic bucket regardless of activity.
    durability.finalizeTurnTerminal(transferFor('synthetic', 'agentjob-moms-1789000001-occ1', 'split-synthetic-chat').params);
    // Real source whose conversation later continued: superseded.
    durability.finalizeTurnTerminal(transferFor('superseded', 'wamid-superseded', 'split-lived-chat').params);
    durability.journalInbound('wamid-later', 'split-lived-chat', 'split-lived-chat:1@g.us', 'agent');
    // Real source, conversation never moved on: genuinely stranded.
    durability.finalizeTurnTerminal(transferFor('stranded', 'wamid-stranded', 'split-quiet-chat').params);
    // Real source in the synthetic's conversation shape but synthetic ID wins:
    durability.finalizeTurnTerminal(transferFor('synthetic-two', 'agentjob-moms-1789000002-occ2', 'split-lived-chat').params);

    const counts = durability.getTurnRecoverySupervisorCounts();

    expect(counts.blockedUnsafe).toBe(4);
    expect(counts.blockedUnsafeSynthetic).toBe(2);
    expect(counts.blockedUnsafeSuperseded).toBe(1);
    expect(counts.blockedUnsafeStranded).toBe(1);
    expect(
      counts.blockedUnsafeSynthetic + counts.blockedUnsafeSuperseded + counts.blockedUnsafeStranded,
    ).toBe(counts.blockedUnsafe);
  });

  it('reports all-zero split buckets on an empty database', () => {
    const counts = durability.getTurnRecoverySupervisorCounts();
    expect(counts.blockedUnsafe).toBe(0);
    expect(counts.blockedUnsafeSynthetic).toBe(0);
    expect(counts.blockedUnsafeSuperseded).toBe(0);
    expect(counts.blockedUnsafeStranded).toBe(0);
  });
});
