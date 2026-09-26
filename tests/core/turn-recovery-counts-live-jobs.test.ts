import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { TurnRecoveryOwnerIdentity } from '../../src/core/durability.ts';
import { getTurnRecoveryHealthDetails } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';
import { runtimeTurnRecoveryIsDegraded } from '../../src/runtimes/agent/runtime-turn-supervisor.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

/**
 * `turn_recovery_degraded` pages on `corruptLinks` and `echoConflicts`. Both
 * must describe live recovery work only (pending, claimed, blocked_unsafe): a
 * completed or exhausted job is no longer a trap, and counting its residue
 * pinned health degraded with nothing left to clear it. That residue stays
 * visible in the diagnostic-only `corruptLinksSettled` and
 * `echoConflictsSettled` counters. Orphan transfers (a transferred terminal
 * record with no job row at all) have no job state to filter on and stay
 * counted, because they block every later turn in their scope.
 */
type Transfer = { jobId: number; recordId: number; inboundSeq: number; opId: number };

describe('turn-recovery corrupt-link and echo-conflict counts cover live jobs only', () => {
  let db: Database;
  let durability: DurabilityEngine;

  const OWNER: TurnRecoveryOwnerIdentity = {
    logicalTurnId: 'live-count-owner-turn',
    managerId: 'live-count-manager',
    generation: 1,
  };

  const NO_FINALIZATION_DEBT = {
    retainedRetries: 0,
    degradedScopes: 0,
    retryAttempts: 0,
    retryRecoveries: 0,
    retryExhaustions: 0,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  function transfer(suffix: string, replaySafe = true): Transfer {
    const conversationKey = `live-count-${suffix}`;
    const deliveryJid = `${conversationKey}@s.whatsapp.net`;
    const messageId = `wamid-live-count-${suffix}`;
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
        managerId: 'live-count-manager',
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
        replaySafe,
        senderJid: '15550100001:7@s.whatsapp.net',
        senderName: 'Live Count Fixture',
        text: `live count fixture ${suffix}`,
        isGroup: false,
      }),
    });
    return { jobId: receipt.recoveryJob!.jobId, recordId: receipt.recordId, inboundSeq, opId };
  }

  /** Worker completion with a failed source and quarantined delivery. */
  function completeByWorker(t: Transfer, suffix: string): void {
    durability.markSending(t.opId);
    durability.markSubmitted(t.opId, `wa-live-count-${suffix}`);
    const claim = durability.claimTurnRecoveryJob(t.jobId, OWNER, {
      claimToken: `live-count-claim-${suffix}`,
      leaseSeconds: 60,
    });
    durability.markInboundFailed(t.inboundSeq, 'crash_recovery');
    durability.markQuarantined(t.opId);
    durability.completeTurnRecoveryJob(t.jobId, OWNER, claim);
    expect(durability.getTurnRecoveryJob(t.jobId)?.state).toBe('completed');
  }

  function claim(t: Transfer, suffix: string): void {
    durability.claimTurnRecoveryJob(t.jobId, OWNER, {
      claimToken: `live-count-claim-${suffix}`,
      leaseSeconds: 60,
    });
  }

  /**
   * Raw state write mirroring the dead-delivery reclaim statement's column
   * set: reaching exhaustion through the age-gated sweep or five
   * claim/requeue cycles adds nothing to what these counts prove.
   */
  function exhaust(jobId: number): void {
    db.raw.prepare(`
      UPDATE turn_recovery_jobs
      SET state = 'exhausted', attempt_count = 5, claim_epoch = 5,
          claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL,
          last_requeue_claim_token_hash = NULL, last_requeue_claim_epoch = NULL,
          last_requeue_backoff_seconds = NULL
      WHERE id = ? AND state = 'pending'
    `).run(jobId);
  }

  /** Breaks the job-to-terminal link the same way the corrupt-scope proof does. */
  function corruptTerminalScope(recordId: number): void {
    db.raw.exec('DROP TRIGGER IF EXISTS turn_terminal_recovery_envelope_immutable');
    db.raw.prepare("UPDATE turn_terminal_records SET scope = 'shared' WHERE id = ?").run(recordId);
  }

  /** A late echo whose source inbound already failed records a job conflict. */
  function echoAfterSourceFailed(t: Transfer, suffix: string): void {
    durability.markSending(t.opId);
    durability.markSubmitted(t.opId, `wa-live-count-${suffix}`);
    durability.markInboundFailed(t.inboundSeq, 'crash_recovery');
    expect(durability.matchEcho(`wa-live-count-${suffix}`)).toBe(true);
  }

  function jobState(jobId: number): unknown {
    return db.raw.prepare('SELECT state FROM turn_recovery_jobs WHERE id = ?').get(jobId);
  }

  function jobConflict(jobId: number): unknown {
    return db.raw.prepare(`
      SELECT state, echo_conflict_reason FROM turn_recovery_jobs WHERE id = ?
    `).get(jobId);
  }

  /** The real runtime predicate behind the turn_recovery_degraded cause. */
  function causeRaised(): boolean {
    return runtimeTurnRecoveryIsDegraded(NO_FINALIZATION_DEBT, getTurnRecoveryHealthDetails(durability));
  }

  it('does not count a corrupt link on a completed job but keeps it as settled residue', () => {
    const t = transfer('completed-corrupt');
    completeByWorker(t, 'completed-corrupt');
    corruptTerminalScope(t.recordId);

    expect(jobState(t.jobId)).toEqual({ state: 'completed' });
    // Every input to turn_recovery_degraded is zero, so the cause stays clear.
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 0,
      exhausted: 0,
      openRecoveries: 0,
      corruptLinks: 0,
      echoConflicts: 0,
      orphanTransfers: 0,
      corruptLinksSettled: 1,
      echoConflictsSettled: 0,
    });
    expect(causeRaised()).toBe(false);
  });

  it.each([
    ['pending', (_t: Transfer): void => undefined, true],
    ['claimed', (t: Transfer): void => claim(t, 'claimed-corrupt'), true],
    ['blocked_unsafe', (_t: Transfer): void => undefined, false],
  ] as const)('counts a corrupt link on a live %s job and raises the cause', (state, arrange, replaySafe) => {
    const t = transfer(`${state}-corrupt`, replaySafe);
    arrange(t);
    corruptTerminalScope(t.recordId);

    expect(jobState(t.jobId)).toEqual({ state });
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      corruptLinks: 1,
      corruptLinksSettled: 0,
    });
    expect(causeRaised()).toBe(true);
  });

  it('does not count a corrupt link on an exhausted job while the exhausted job still counts', () => {
    const t = transfer('exhausted-corrupt');
    exhaust(t.jobId);
    corruptTerminalScope(t.recordId);

    expect(jobState(t.jobId)).toEqual({ state: 'exhausted' });
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      exhausted: 1,
      corruptLinks: 0,
      corruptLinksSettled: 1,
    });
  });

  it('does not count a late-echo conflict on a completed job but keeps the durable evidence', () => {
    const t = transfer('completed-echo');
    completeByWorker(t, 'completed-echo');

    expect(durability.matchEcho('wa-live-count-completed-echo')).toBe(true);
    expect(jobConflict(t.jobId)).toEqual({
      state: 'completed',
      echo_conflict_reason: 'completed_job_source_conflict',
    });
    // Every input to turn_recovery_degraded is zero, so the cause stays clear.
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 0,
      exhausted: 0,
      openRecoveries: 0,
      corruptLinks: 0,
      echoConflicts: 0,
      echoConflictsSettled: 1,
      corruptLinksSettled: 0,
    });
    expect(causeRaised()).toBe(false);
  });

  it('does not count an echo conflict on an exhausted job but keeps it as settled residue', () => {
    const t = transfer('exhausted-echo');
    exhaust(t.jobId);
    echoAfterSourceFailed(t, 'exhausted-echo');

    expect(jobConflict(t.jobId)).toEqual({
      state: 'exhausted',
      echo_conflict_reason: 'open_job_source_not_echo_settleable',
    });
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      exhausted: 1,
      echoConflicts: 0,
      echoConflictsSettled: 1,
    });
  });

  it.each([
    ['pending', (_t: Transfer): void => undefined, true],
    ['claimed', (t: Transfer): void => claim(t, 'claimed-echo'), true],
    ['blocked_unsafe', (_t: Transfer): void => undefined, false],
  ] as const)('counts an echo conflict on a live %s job and raises the cause', (state, arrange, replaySafe) => {
    const t = transfer(`${state}-echo`, replaySafe);
    arrange(t);
    echoAfterSourceFailed(t, `${state}-echo`);

    expect(jobConflict(t.jobId)).toEqual({
      state,
      echo_conflict_reason: 'open_job_source_not_echo_settleable',
    });
    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      echoConflicts: 1,
      echoConflictsSettled: 0,
    });
    expect(causeRaised()).toBe(true);
  });

  it('keeps an orphan transfer visible as outstanding, corrupt, and orphaned', () => {
    const t = transfer('orphan');
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?').run(t.jobId);

    expect(durability.getTurnRecoverySupervisorCounts()).toMatchObject({
      outstanding: 1,
      corruptLinks: 1,
      orphanTransfers: 1,
      corruptLinksSettled: 0,
    });
  });
});
