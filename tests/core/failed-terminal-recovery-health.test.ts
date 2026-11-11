import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { normalizeRecoveryDebt } from '../../src/core/recovery-debt.ts';
import { closeOperatorCatchupRecovery } from '../../src/core/recovery-catchup-closure.ts';
import { getTurnRecoveryHealthDetails } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';
import { classifyRuntimeRecoveryHealth } from '../../src/runtimes/agent/runtime-recovery-health.ts';
import { toTurnFinalizationPersistence, type TurnTerminalResult } from '../../src/runtimes/agent/turn-terminal.ts';

describe('failed terminal reply obligations in recovery health', () => {
  let db: Database;
  let durability: DurabilityEngine;
  const conversationKey = 'failed-terminal-health';
  const deliveryJid = '15550100001@s.whatsapp.net';

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });
  afterEach(() => db.close());

  function terminal(messageId: string, outcome: 'crash' | 'operator_cancelled' | 'replied' | 'policy' = 'crash') {
    const seq = durability.journalInbound(messageId, conversationKey, deliveryJid, 'agent');
    let deliveryEvidence: TurnTerminalResult['deliveryEvidence'] = { kind: 'none' };
    if (outcome === 'replied') {
      const opId = echo(seq, messageId);
      deliveryEvidence = { kind: 'echoed', opId };
    }
    const result: TurnTerminalResult = {
      identity: { scope: 'per_chat', conversationKey, deliveryJid, inboundSeq: seq,
        logicalTurnId: `turn-${messageId}`, managerId: 'health-manager', generation: 1 },
      attemptOutcome: outcome === 'replied' ? { kind: 'completed' }
        : outcome === 'policy' ? { kind: 'suppressed_by_policy' }
          : { kind: 'failed', class: outcome },
      inboundDisposition: outcome === 'replied' ? 'finalized_replied'
        : outcome === 'policy' ? 'finalized_no_reply_policy' : 'failed_terminal',
      deliveryEvidence,
    };
    durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result));
    return seq;
  }

  function echo(seq: number, suffix: string): number {
    const opId = durability.createOutboundOp({ conversationKey, chatJid: deliveryJid,
      opType: 'text', payload: JSON.stringify({ text: suffix }), sourceInboundSeq: seq,
      replayPolicy: 'unsafe' });
    durability.markSending(opId);
    durability.markSubmitted(opId, `echo-${suffix}`);
    expect(durability.matchEcho(`echo-${suffix}`)).toBe(true);
    return opId;
  }

  function health() {
    const details = getTurnRecoveryHealthDetails(durability);
    const classification = classifyRuntimeRecoveryHealth({
      finalization: { retainedRetries: 0, degradedScopes: 0, retryAttempts: 0,
        retryRecoveries: 0, retryExhaustions: 0 },
      recovery: details,
      completedDeliveryIdentity: { unresolvedCount: 0, nextAction: null },
    });
    return normalizeRecoveryDebt({
      continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 },
      runtime: { readable: true, details: { ...details,
        recoveryBlockingReasons: classification.blockingReasons,
        recoveryDebtReasons: classification.retainedReasons,
        completedDeliveryIdentityBlocking: 0, completedDeliveryIdentityRetained: 0,
        completedDeliveryIdentityAdmissions: { nextAction: null } } },
      durability: { readable: true, deliveryBlocking: false,
        deliveryAmbiguity: { readable: true, uncorroboratedAmbiguous: 0,
          corroboratedRetained: 0, oldestUncorroboratedAt: null } },
    });
  }

  it('retains a failed user reply with no recovery job without blocking service', () => {
    const seq = terminal('failed-user-request');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM turn_recovery_jobs').get()).toEqual({ n: 0 });
    expect(health()).toMatchObject({ open: true, service_blocking: false, attention: 'routine',
      reasons: ['turn_recovery_terminal'], turn_recovery: { retained_terminal: 1 } });
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({ outstanding: 0, blockingOutstanding: 0 });
    expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq))
      .toEqual({ processing_status: 'failed' });
  });

  it('does not treat an echoed retry notice or a later unrelated reply as fulfillment', () => {
    const seq = terminal('failed-with-notice');
    const opId = echo(seq, 'retry-notice');
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ is_terminal: 0 });
    terminal('later-unrelated-request', 'replied');
    expect(health()).toMatchObject({ open: true, turn_recovery: { retained_terminal: 1 } });
  });

  it.each(['operator_cancelled', 'replied', 'policy'] as const)('keeps %s out of failed reply debt', (outcome) => {
    terminal(`intentional-${outcome}`, outcome);
    expect(health()).toMatchObject({ open: false, service_blocking: false,
      turn_recovery: { retained_terminal: 0 } });
  });

  it('does not count scheduled self-turns but keeps case-distinct real source IDs', () => {
    terminal('agentjob-daily-1');
    expect(health().open).toBe(false);
    terminal('AGENTJOB-real-user-1');
    expect(health().turn_recovery.retained_terminal).toBe(1);
  });

  it('counts one obligation when the failed finalization is repeated', () => {
    const messageId = 'repeated-terminal';
    const seq = terminal(messageId);
    const result: TurnTerminalResult = {
      identity: { scope: 'per_chat', conversationKey, deliveryJid, inboundSeq: seq,
        logicalTurnId: `turn-${messageId}`, managerId: 'health-manager', generation: 1 },
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'failed_terminal', deliveryEvidence: { kind: 'none' },
    };
    durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM turn_terminal_records WHERE inbound_seq = ?').get(seq))
      .toEqual({ n: 1 });
    expect(health().turn_recovery.retained_terminal).toBe(1);
  });

  it('hands accounting to an operator catch-up and closes only through its durable proof', () => {
    const seq = terminal('catchup-source');
    db.raw.exec(`INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES ('failed-reply-plan', 'pre_connect_recovery', 'system:test', 'fixture', 'test://fixture')`);
    db.raw.prepare(`INSERT INTO inbound_disposition_links
      (inbound_seq, recovery_plan_id, disposition, reason, evidence_ref, actor)
      VALUES (?, 'failed-reply-plan', 'recovery_pending_operator_catchup', 'fixture', 'test://fixture', 'system:test')`).run(seq);
    expect(health()).toMatchObject({ open: true, reasons: ['historical_turn_catchup'],
      turn_recovery: { retained_terminal: 0, open_catchups: 1 } });
    const catchupSeq = terminal('verified-catchup', 'replied');
    closeOperatorCatchupRecovery(db, { planId: 'failed-reply-plan', conversationKey,
      expectedSourceSeqs: [seq], catchupSeq, actor: 'operator:test', evidenceRef: 'test://delivered-catchup' });
    expect(health()).toMatchObject({ open: false, turn_recovery: { retained_terminal: 0, open_catchups: 0 } });
    expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq))
      .toEqual({ processing_status: 'failed' });
  });

  it('propagates unreadable evidence instead of returning a false zero', () => {
    db.close();
    expect(() => getTurnRecoveryHealthDetails(durability)).toThrow();
  });
});
