import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    options: { resolveOriginalDelivery?: boolean; suffix?: string } = {},
  ): {
    jobId: number;
    conversationKey: string;
    deliveryJid: string;
    sourceInboundSeq: number;
    deliveryOpId: number;
  } {
    const resolveOriginalDelivery = options.resolveOriginalDelivery ?? true;
    // Suffix distinguishes independent crashed source turns seeded into the
    // SAME scope (e.g. the "second unrelated job still blocks" excludeJobId
    // assertion) — without it, a second call would re-journal the same
    // wamid into the same conversation and collide with the first job.
    const suffix = options.suffix ?? 'brick';
    const conversationKey = 'brick-lab-chat';
    const deliveryJid = 'brick-lab-chat:1@g.us';
    const inboundSeq = durability.journalInbound(
      `wamid-brick-source-${suffix}`,
      conversationKey,
      deliveryJid,
      'agent',
    );
    const terminal = terminalResult(inboundSeq, suffix);
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
    const envelope = replayEnvelope(suffix, { sourceMessageId: `wamid-brick-source-${suffix}` });
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
   * Calls the REAL `hasOutstandingTurnRecoveryForScope` — the actual store
   * predicate `RuntimeTurnCoordinator.beginRuntimeTurnEvidence`
   * (runtime-turn-coordinator.ts:368-393) gates admission on, against a real
   * SQLite-backed `DurabilityEngine` — not a reimplementation. Only the
   * throw-wrapping and the second (unrelated, in-memory) `runtimeTurnSupervisor
   * .canAccept` check are elided, since constructing a full coordinator/host
   * is out of scope here and that second check is orthogonal to durable
   * recovery admission. `excludeJobId` threads straight through to the real
   * SQL so a bug in the exclusion predicate itself would fail these tests,
   * not just a bug in whether it's wired up.
   */
  function attemptAdmission(
    scope: 'per_chat' | 'shared' | 'singleton',
    conversationKey: string,
    excludeJobId?: number,
  ): void {
    if (
      durability.hasOutstandingTurnRecoveryForScope(
        scope,
        conversationKey,
        excludeJobId !== undefined ? { excludeJobId } : undefined,
      )
    ) {
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

  describe('admission self-block — excludeJobId (PRESTAGE-T4)', () => {
    /**
     * Without `excludeJobId`, a supervisor replaying its own claimed job
     * through the normal admission gate would find that SAME job still
     * outstanding in-scope and throw — deadlocking against itself, since the
     * job cannot reach a terminal state until the replay it is gating
     * completes. These three assertions exercise the REAL
     * `hasOutstandingTurnRecoveryForScope` SQL (via `attemptAdmission`, not a
     * reimplementation) — a bug in the exclusion predicate's SQL itself
     * would fail these, not just a bug in whether the parameter is threaded.
     */

    it('(1) a different inbound for the same scope is still rejected while the job is outstanding', () => {
      const { conversationKey } = crashOneSourceTurn();
      expect(() => attemptAdmission('per_chat', conversationKey)).toThrow(
        'Runtime turn scope is blocked by outstanding durable recovery',
      );
    });

    it('(2) the supervisor own replay is admitted via excludeJobId while its own job is still claimed', () => {
      const { jobId, conversationKey } = crashOneSourceTurn();

      // Claim the job as the supervisor would before dispatching replay —
      // state moves pending -> claimed, still outstanding by the plain check.
      const claim = durability.claimTurnRecoveryJob(
        jobId,
        { logicalTurnId: 'brick-source-turn', managerId: 'manager-source', generation: 3 },
        { claimToken: 'claim-excludejobid-2', leaseSeconds: 120 },
      );
      expect(claim.applied).toBe(true);
      expect(durability.getTurnRecoveryJob(jobId)?.state).toBe('claimed');

      // Without exclusion: the job's own claim still blocks (proves the
      // self-block condition is real, not hypothetical).
      expect(() => attemptAdmission('per_chat', conversationKey)).toThrow(
        'Runtime turn scope is blocked by outstanding durable recovery',
      );

      // With exclusion: the supervisor's OWN replay for this exact job is
      // admitted — this is the fix. Real SQL, real excludeJobId bind.
      expect(() => attemptAdmission('per_chat', conversationKey, jobId)).not.toThrow();
    });

    it('(3) a second, unrelated outstanding job in the same scope still blocks even with the first excluded', () => {
      const first = crashOneSourceTurn({ suffix: 'one' });
      // Second, independently crashed source turn in the SAME scope —
      // proves excludeJobId is a scalpel (excludes exactly one row), not a
      // scope-wide bypass that would silently unblock every other job too.
      const second = crashOneSourceTurn({ suffix: 'two' });
      expect(second.jobId).not.toBe(first.jobId);

      // Excluding the first job must NOT admit — the second job (untouched,
      // still pending) is still outstanding in the same scope.
      expect(() => attemptAdmission('per_chat', first.conversationKey, first.jobId)).toThrow(
        'Runtime turn scope is blocked by outstanding durable recovery',
      );

      // Sanity: excluding the SECOND job instead leaves the first blocking —
      // confirms the exclusion targets the specific id, not "any one job".
      expect(() => attemptAdmission('per_chat', second.conversationKey, second.jobId)).toThrow(
        'Runtime turn scope is blocked by outstanding durable recovery',
      );
    });
  });

  it('renews the lease while a long-running replay dispatch is pending (PRESTAGE-T4 point 7)', async () => {
    vi.useFakeTimers();
    try {
      const { jobId, conversationKey, sourceInboundSeq } = crashOneSourceTurn({ suffix: 'lease' });
      const renewSpy = vi.spyOn(durability, 'renewTurnRecoveryClaim');

      // Deferred, not a real setTimeout: the dispatch "completes" only when
      // this test explicitly releases it, after fake time has been advanced
      // past the renewal interval — proves renewal fires WHILE dispatch is
      // still pending, not merely that it could fire eventually.
      let resolveDispatch: () => void = () => {};
      const dispatchGate = new Promise<void>((resolve) => { resolveDispatch = resolve; });

      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'brick-instance',
        durability: () => durability,
        // leaseSeconds=3 -> renewal interval = max(1000, 1500) = 1500ms, so
        // the first renewal fires with 1500ms of margin before the 3000ms
        // lease would otherwise expire.
        leaseSeconds: 3,
        freshOwnerIdentity: (): TurnRecoveryOwnerIdentity => ({
          logicalTurnId: 'brick-recovery-owner-lease',
          managerId: 'brick-supervisor',
          generation: 1,
        }),
        dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
          await dispatchGate;
          durability.completeInbound(sourceInboundSeq, 'response_sent');
          return { kind: 'delivered' };
        },
      });

      const scanPromise = supervisor.scanOnce();
      // Flush the synchronous claim -> dispatchReplay() call chain so the
      // renewal interval is armed before advancing fake time past it.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(renewSpy).toHaveBeenCalled();
      expect(supervisor.health().leaseRenewals).toBeGreaterThanOrEqual(1);
      expect(supervisor.health().leaseRenewalFailures).toBe(0);

      resolveDispatch();
      const result = await scanPromise;
      expect(result.completed).toBe(1);

      const job = durability.getTurnRecoveryJob(jobId);
      expect(job?.state).toBe('completed');
      expect(() => attemptAdmission('per_chat', conversationKey)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
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

  it('SETTLING TEST (boterr-lead PR1 adjudication): claim -> dispatch(delivered) -> completeTurnRecoveryJob refuses (source inbound not yet terminal) -> claim expires -> reclaim -- does the second scan re-dispatch?', async () => {
    const { jobId } = crashOneSourceTurn();

    let dispatchCalls = 0;
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'brick-instance',
      durability: () => durability,
      freshOwnerIdentity: (): TurnRecoveryOwnerIdentity => ({
        logicalTurnId: 'brick-recovery-owner-settling',
        managerId: 'brick-supervisor',
        generation: 1,
      }),
      dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
        dispatchCalls += 1;
        // Deliberately does NOT call completeInbound: the replay reports a
        // genuine successful send (delivered), but the ORIGINAL source
        // inbound is left non-terminal. This forces completeTurnRecoveryJob's
        // own SQL gate (turn-recovery-store.ts:1187-1197) to throw
        // ('Recovery source inbound must be terminal before job
        // completion'), reproducing exactly the scenario from the
        // reachability read: a real dispatch succeeded, but the completion
        // bookkeeping cannot close the job on this attempt.
        return { kind: 'delivered' };
      },
    });

    const firstScan = await supervisor.scanOnce();
    expect(firstScan.claimed).toBe(1);
    expect(firstScan.completed).toBe(0);
    expect(firstScan.processingErrors).toBe(1);
    expect(dispatchCalls).toBe(1);

    const jobAfterFirst = durability.getTurnRecoveryJob(jobId);
    expect(jobAfterFirst).toMatchObject({ state: 'claimed', attempt_count: 1 });

    // Simulate real-time lease expiry deterministically instead of a real
    // wall-clock wait: claim_expires_at is not one of the immutable-envelope
    // trigger's protected columns (only identity/routing fields are), so
    // backdating it directly is a safe, faithful stand-in for "leaseSeconds
    // has genuinely elapsed" — recoverStaleTurnRecoveryJobs reads exactly
    // this column to decide staleness.
    db.raw.prepare(`UPDATE turn_recovery_jobs SET claim_expires_at = datetime('now', '-10 seconds') WHERE id = ?`)
      .run(jobId);

    const secondScan = await supervisor.scanOnce();

    // SETTLED (real, observed values — not a prediction): the second scan's
    // stale-claim sweep (recoverStaleTurnRecoveryJobs, called at the top of
    // runScan before enumeration) already transitions the job pending ->
    // claimed's expiry is swept BEFORE processJob ever sees it as 'claimed',
    // so it is re-enumerated as 'pending' and re-claimed via the ORDINARY
    // pending-claim path, not the explicit reassignment branch — hence
    // `reassigned: 0`, not 1 as a naive prediction would expect. The
    // dispatcher-facing outcome is unambiguous: dispatchCalls reaches 2.
    // This IS the confirmed double-send surface: nothing in claimAndReplay
    // distinguishes "this job's own prior replay may already have sent for
    // real" from an ordinary reclaim of abandoned work, so the second scan
    // re-dispatches through the exact same path a genuinely-never-attempted
    // job would take.
    expect(secondScan).toMatchObject({ claimed: 1, reassigned: 0, completed: 0, processingErrors: 1 });
    expect(dispatchCalls).toBe(2);

    const jobAfterSecond = durability.getTurnRecoveryJob(jobId);
    expect(jobAfterSecond).toMatchObject({ state: 'claimed', attempt_count: 2 });
  });

  it('PRE-DISPATCH SKIP GUARD (boterr-lead ruling): source already proven at claim time -- completes directly via completeTurnRecoveryJob, dispatchReplay is NEVER invoked', async () => {
    const { jobId, sourceInboundSeq } = crashOneSourceTurn();
    // Source already proven BEFORE the supervisor ever claims this job --
    // stands in for a successor job (a real second recovery job in
    // production; see the extended e2e in
    // tests/runtimes/agent/turn-recovery-live-wiring.test.ts) having already
    // delivered it for real. crashOneSourceTurn's default
    // resolveOriginalDelivery:true already marks the original delivery
    // 'quarantined' (the outbound half of the proof); completeInbound
    // supplies the missing source-inbound half.
    durability.completeInbound(sourceInboundSeq, 'response_sent');

    let dispatchCalls = 0;
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'brick-instance',
      durability: () => durability,
      freshOwnerIdentity: (): TurnRecoveryOwnerIdentity => ({
        logicalTurnId: 'brick-recovery-owner-preproven',
        managerId: 'brick-supervisor',
        generation: 1,
      }),
      dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
        dispatchCalls += 1;
        throw new Error('dispatchReplay must never be called when the source is already proven at claim time');
      },
    });

    const scan = await supervisor.scanOnce();

    // If the pre-dispatch guard did NOT fire, dispatchReplay would run,
    // throw, get caught by claimAndReplay's own try/catch (converted to a
    // retryable_failure, not a test crash), and this job would requeue
    // instead of completing -- so completed:1 + dispatchCalls:0 together are
    // the unambiguous, non-vacuous signal the guard actually short-circuited
    // dispatch, not just that SOME outcome happened to look similar.
    expect(scan).toMatchObject({ claimed: 1, completed: 1, processingErrors: 0 });
    expect(dispatchCalls).toBe(0);

    const job = durability.getTurnRecoveryJob(jobId);
    expect(job).toMatchObject({ state: 'completed' });
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
        leaseRenewals: 0,
        leaseRenewalFailures: 0,
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
        leaseRenewals: 0,
        leaseRenewalFailures: 0,
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
        leaseRenewals: 0,
        leaseRenewalFailures: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: true, reason: 'ok' });
  });
});
