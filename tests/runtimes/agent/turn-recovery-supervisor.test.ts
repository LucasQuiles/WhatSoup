import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import {
  DurabilityEngine,
  type TurnRecoveryOwnerIdentity,
} from '../../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../../src/runtimes/agent/turn-terminal.ts';
import {
  TurnRecoverySupervisor,
  evaluateTurnRecoverySupervisorHeartbeat,
  type TurnRecoveryReplayDispatchResult,
} from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';

// ─── Fixture helpers (mirrors tests/core/turn-recovery-jobs.test.ts) ───────

const OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'brick-source-turn',
  managerId: 'manager-source',
  generation: 3,
};

function terminalResult(
  inboundSeq: number,
  suffix: string,
): { result: TurnTerminalResult; owner: RecoveryOwnerIdentity } {
  return {
    result: {
      identity: {
        scope: 'per_chat',
        conversationKey: 'brick-lab-chat',
        deliveryJid: 'brick-lab-chat:1@g.us',
        inboundSeq,
        logicalTurnId: `turn-source-${suffix}`,
        managerId: 'manager-source',
        generation: 3,
      },
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId: 41 },
    },
    owner: OWNER,
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
    senderName: 'Brick Owner',
    text: 'Brick queue SLA alert: restart the worker',
    isGroup: true,
    groupName: 'BRICK LAB',
    ...overrides,
  };
}

describe('TurnRecoverySupervisor — BRICK-LAB-shaped regression', () => {
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

  /**
   * Crashes one source turn (the BRICK queue-SLA alert) durably transferred to
   * recovery, with its original selected-delivery op already resolved to a
   * terminal outbound state (quarantined) — representing the predecessor
   * reconnect/live-maybe-sent reconciliation (#2079) having already run.
   * `completeTurnRecoveryJob` requires that precondition; this fixture starts
   * from the state the supervisor actually observes in production, not a
   * still-ambiguous original send.
   */
  function crashOneSourceTurn(
    options: { resolveOriginalDelivery?: boolean } = {},
  ): {
    jobId: number;
    conversationKey: string;
    deliveryJid: string;
    sourceInboundSeq: number;
    deliveryOpId: number;
  } {
    const resolveOriginalDelivery = options.resolveOriginalDelivery ?? true;
    const conversationKey = 'brick-lab-chat';
    const deliveryJid = 'brick-lab-chat:1@g.us';
    const inboundSeq = durability.journalInbound(
      'wamid-brick-source',
      conversationKey,
      deliveryJid,
      'agent',
    );
    const terminal = terminalResult(inboundSeq, 'brick');
    const identity = { ...terminal.result.identity, inboundSeq, conversationKey, deliveryJid };
    const deliveryOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'text',
      payload: JSON.stringify({ text: 'session terminated after 30 minutes ... restarting' }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
    });
    const result: TurnTerminalResult = {
      ...terminal.result,
      identity,
      deliveryEvidence: { kind: 'enqueued', opId: deliveryOpId },
    };
    const envelope = replayEnvelope('brick', { sourceMessageId: 'wamid-brick-source' });
    const params = {
      ...toTurnFinalizationPersistence(result, terminal.owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, terminal.owner, envelope),
    };
    const receipt = durability.finalizeTurnTerminal(params);
    const jobId = receipt.recoveryJob!.jobId;

    durability.markSending(deliveryOpId);
    if (resolveOriginalDelivery) {
      // The predecessor edge (#2079 reconcileLiveMaybeSent) already resolved
      // the ambiguous original send by the time the supervisor scans: mark it
      // sending -> quarantined so completeTurnRecoveryJob's source-status gate
      // is satisfiable by this fixture, same as production.
      db.raw.prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE id = ?`).run(deliveryOpId);
    } else {
      // #2079's periodic reconciler hasn't reached this row yet: the
      // original send is still ambiguous. Leave it maybe_sent.
      db.raw.prepare(`UPDATE outbound_ops SET status = 'maybe_sent' WHERE id = ?`).run(deliveryOpId);
    }

    return { jobId, conversationKey, deliveryJid, sourceInboundSeq: inboundSeq, deliveryOpId };
  }

  /** One follower inbound message arriving in the same crashed chat scope. */
  function arriveFollower(conversationKey: string, deliveryJid: string, suffix: string): void {
    durability.journalInbound(`wamid-follower-${suffix}`, conversationKey, deliveryJid, 'agent');
  }

  /**
   * Mirrors the EXACT production admission gate — the durable-recovery half
   * of `RuntimeTurnCoordinator.beginRuntimeTurnEvidence`
   * (runtime-turn-coordinator.ts:368-381) — without constructing a full
   * coordinator/host: same predicate, same throw. A new inbound is
   * "rejected" iff this throws; "admitted" iff it does not.
   */
  function attemptAdmission(scope: 'per_chat' | 'shared' | 'singleton', conversationKey: string): void {
    if (durability.hasOutstandingTurnRecoveryForScope(scope, conversationKey)) {
      throw new Error('Runtime turn scope is blocked by outstanding durable recovery');
    }
  }

  it('claims and replays the crashed source exactly once while four followers stay blocked, then flips admission open on completion — no duplicate replay dispatch', async () => {
    const { jobId, conversationKey, deliveryJid, sourceInboundSeq } = crashOneSourceTurn();

    // Four follower messages land in the same scope while the job is
    // pending/unclaimed (attempts=0, claim epoch=0 — the 1474-class wedge).
    for (const suffix of ['a', 'b', 'c', 'd']) {
      arriveFollower(conversationKey, deliveryJid, suffix);
    }
    const seededJob = durability.getTurnRecoveryJob(jobId);
    expect(seededJob).toMatchObject({ state: 'pending', attempt_count: 0, claim_epoch: 0 });

    // Step 2: reproduces the live wedge — a fifth, brand-new inbound for the
    // SAME scope is REJECTED while the dormant job sits unclaimed. This is
    // the RED that proves the admission guard actually blocks, not just
    // that the store flag is set.
    expect(() => attemptAdmission('per_chat', conversationKey)).toThrow(
      'Runtime turn scope is blocked by outstanding durable recovery',
    );

    let dispatchCalls = 0;
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'brick-instance',
      durability: () => durability,
      freshOwnerIdentity: (): TurnRecoveryOwnerIdentity => ({
        logicalTurnId: 'brick-recovery-owner',
        managerId: 'brick-supervisor',
        generation: 1,
      }),
      dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
        dispatchCalls += 1;
        // Stands in for the replay running the FULL normal pipeline and
        // reaching its own terminal finalization — which, in production,
        // is what marks the ORIGINAL source inbound complete (the same
        // completeInbound() call any live turn's finalizer makes). This is
        // completeTurnRecoveryJob's own source-status precondition
        // (getTurnRecoverySourceInboundStatus), discovered by the first
        // real test run: a job cannot complete while its source inbound is
        // still open, regardless of the replay's own delivery outcome.
        durability.completeInbound(sourceInboundSeq, 'response_sent');
        return { kind: 'delivered' };
      },
    });

    // Step 3: supervisor cycle claims, replays (dispatcher stands in for the
    // replay turn's own normal-pipeline send), and completes the job off
    // that replay's own proven delivery (completeTurnRecoveryJob), not the
    // original crashed op's echo settlement (a separate, untouched path).
    const firstScan = await supervisor.scanOnce();
    expect(firstScan.claimed).toBe(1);
    expect(firstScan.completed).toBe(1);
    expect(dispatchCalls).toBe(1);

    const job = durability.getTurnRecoveryJob(jobId);
    expect(job?.state).toBe('completed');

    // Step 4 (load-bearing): admission FLIPS open for the exact same scope —
    // proves the user-visible symptom (chat wedged) is actually resolved,
    // not merely that the job row changed state.
    expect(() => attemptAdmission('per_chat', conversationKey)).not.toThrow();

    // A second scan must be a no-op: the job is completed, not re-claimed,
    // and the dispatcher is not invoked again (no duplicate output).
    const secondScan = await supervisor.scanOnce();
    expect(secondScan.claimed).toBe(0);
    expect(dispatchCalls).toBe(1);
  });

  it('requeues on a retryable dispatch failure without completing the job or unblocking the scope', async () => {
    const { jobId, conversationKey } = crashOneSourceTurn();

    let dispatchCalls = 0;
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'brick-instance',
      durability: () => durability,
      freshOwnerIdentity: (): TurnRecoveryOwnerIdentity => ({
        logicalTurnId: 'brick-recovery-owner-retry',
        managerId: 'brick-supervisor',
        generation: 1,
      }),
      dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
        dispatchCalls += 1;
        return { kind: 'retryable_failure' };
      },
    });

    const scan = await supervisor.scanOnce();
    expect(scan.claimed).toBe(1);
    expect(scan.completed).toBe(0);
    expect(scan.requeued).toBe(1);
    expect(dispatchCalls).toBe(1);

    const job = durability.getTurnRecoveryJob(jobId);
    expect(job?.state).toBe('pending');
    expect(job?.attempt_count).toBe(1);
    expect(() => attemptAdmission('per_chat', conversationKey)).toThrow(
      'Runtime turn scope is blocked by outstanding durable recovery',
    );
  });

  it('does NOT claim or dispatch a due, replay-safe job whose ORIGINAL delivery is still ambiguous — the duplicate-send guard', async () => {
    // #2079's periodic reconciler has not reached this row yet (still
    // maybe_sent) — completeTurnRecoveryJob would refuse to close the job
    // regardless of the replay outcome, so claiming here would risk a real
    // second send with no way to ever mark the job done from this claim.
    const { jobId, conversationKey, sourceInboundSeq } = crashOneSourceTurn({ resolveOriginalDelivery: false });

    let dispatchCalls = 0;
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'brick-instance',
      durability: () => durability,
      freshOwnerIdentity: (): TurnRecoveryOwnerIdentity => ({
        logicalTurnId: 'brick-recovery-owner-ambiguous',
        managerId: 'brick-supervisor',
        generation: 1,
      }),
      dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
        dispatchCalls += 1;
        // Matches the happy-path fixture: stands in for the replay's own
        // normal-pipeline finalization completing the ORIGINAL source
        // inbound (completeTurnRecoveryJob's other precondition).
        durability.completeInbound(sourceInboundSeq, 'response_sent');
        return { kind: 'delivered' };
      },
    });

    const scan = await supervisor.scanOnce();
    expect(scan.claimed).toBe(0);
    expect(scan.skippedOriginalDeliveryPending).toBe(1);
    expect(dispatchCalls).toBe(0);

    // Job is completely untouched — no claim was taken, so nothing to
    // undo; the next scan retries the same check for free.
    const job = durability.getTurnRecoveryJob(jobId);
    expect(job).toMatchObject({ state: 'pending', attempt_count: 0, claim_epoch: 0 });
    expect(() => attemptAdmission('per_chat', conversationKey)).toThrow(
      'Runtime turn scope is blocked by outstanding durable recovery',
    );

    // Once the predecessor reconciler resolves the original delivery
    // (simulating #2079 catching up), the NEXT scan claims and replays
    // normally — proving the skip is a deferral, not a permanent block.
    db.raw.prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE conversation_key = ?`)
      .run(conversationKey);
    const secondScan = await supervisor.scanOnce();
    expect(secondScan.claimed).toBe(1);
    expect(secondScan.completed).toBe(1);
    expect(dispatchCalls).toBe(1);
  });
});

describe('TurnRecoverySupervisor — deadman heartbeat evaluation', () => {
  it('flags an unhealthy heartbeat when the supervisor has never scanned', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: null,
        scans: 0,
        claims: 0,
        completions: 0,
        requeues: 0,
        exhaustions: 0,
        reassignments: 0,
        dispatchFailures: 0,
        processingErrors: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: false, reason: 'never_scanned' });
  });

  it('flags an unhealthy heartbeat when the last scan is older than the stale threshold — a stalled/crashed loop', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: 1_000_000 - 120_000,
        scans: 40,
        claims: 3,
        completions: 3,
        requeues: 0,
        exhaustions: 0,
        reassignments: 0,
        dispatchFailures: 0,
        processingErrors: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: false, reason: 'stale_scan' });
  });

  it('reports healthy when the last scan is within the stale threshold', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: 1_000_000 - 5_000,
        scans: 40,
        claims: 3,
        completions: 3,
        requeues: 0,
        exhaustions: 0,
        reassignments: 0,
        dispatchFailures: 0,
        processingErrors: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: true, reason: 'ok' });
  });
});
