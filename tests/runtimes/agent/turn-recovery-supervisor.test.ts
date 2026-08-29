import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import {
  DurabilityEngine,
  type TurnRecoveryOwnerIdentity,
} from '../../../src/core/durability.ts';
import { TurnRecoveryClaimFenceError } from '../../../src/core/turn-recovery-store.ts';
import { ScopeBlockedByDurableRecoveryError } from '../../../src/runtimes/agent/turn-admission-errors.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../../src/runtimes/agent/turn-terminal.ts';
import {
  DEFAULT_LEASE_SECONDS,
  SCAN_PAGE_SIZE,
  TurnRecoverySupervisor,
  evaluateTurnRecoverySupervisorHeartbeat,
  type TurnRecoveryDispatchTarget,
  type TurnRecoveryReplayAbortControl,
  type TurnRecoveryReplayDispatchResult,
  type TurnRecoverySupervisorDurability,
} from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';
import { TurnRecoveryDeadman } from '../../../src/runtimes/agent/turn-recovery-deadman.ts';

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
    receivedAtUnixSeconds: 1_780_000_000,
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
   * Deadlines derived from the lease the store ACTUALLY wrote for this claim.
   *
   * Read it straight after the claim (the guard arms synchronously inside
   * `scanOnce()`, and a later renewal overwrites the row), so the assertion is
   * anchored to the real lease rather than to wall-clock arithmetic.
   *
   * `abortMarginMs` mirrors production's
   * `min(15_000, max(250, floor(leaseMs / 4)))` in
   * turn-recovery-supervisor.ts. Mirrored deliberately: this suite exists to
   * pin the temporal invariant, so a silent change to the margin SHOULD fail
   * here rather than quietly widen the window a replay may run past its lease.
   */
  function leaseDeadlines(
    jobId: number,
    leaseSeconds: number,
  ): { expiresAtMs: number; safetyDeadlineMs: number } {
    const recorded = durability.getTurnRecoveryJob(jobId)?.claim_expires_at;
    if (!recorded) throw new Error('expected a claimed job carrying a lease expiry');
    const expiresAtMs = Date.parse(`${recorded.replace(' ', 'T')}Z`);
    if (!Number.isFinite(expiresAtMs)) throw new Error(`unparseable lease expiry: ${recorded}`);
    const leaseMs = leaseSeconds * 1_000;
    const abortMarginMs = Math.min(15_000, Math.max(250, Math.floor(leaseMs / 4)));
    return { expiresAtMs, safetyDeadlineMs: expiresAtMs - abortMarginMs };
  }

  /**
   * Advance fake time in bounded steps until `condition` holds.
   *
   * The lease guard's schedule is derived from `claim_expires_at`, which the
   * store writes with SQLite's OWN clock (`datetime('now', ?)` in
   * turn-recovery-store.ts) — a clock vitest's fake timers do not control,
   * compared against a faked `Date.now()`. A hardcoded
   * `advanceTimersByTimeAsync(N)` therefore encodes a silent assumption that
   * the two clocks stay close enough for the whole renewal/abort schedule to
   * land inside N. When that assumption breaks the guard's timers simply never
   * come due: the job is claimed and dispatched, nothing is renewed, nothing
   * is aborted, and the assertion fails as a bare "0 calls" with no clue why.
   *
   * An A/B under induced skew proves the mechanism: with a 3s skew the old
   * hardcoded 2_600ms advance fails with `Number of calls: 0` while the
   * condition-based wait passes. That signature matches the quality (25.x)
   * failure of 2026-08-16, where this test logged ZERO renewal attempts and
   * the passing lane logged three, with no other supervisor log line
   * differing. What delayed that particular CI process is NOT established —
   * the mechanism is proven, the original trigger remains unknown.
   *
   * Waiting on the observable the test actually asserts removes the timing
   * constant entirely, and the exhausted budget throws a named error instead
   * of leaving a misleading assertion failure. Callers still pin the temporal
   * invariant via `leaseDeadlines`, so this cannot degrade "before the safety
   * deadline" into "eventually".
   *
   * NB: `vi.useFakeTimers()` also fakes `process.hrtime`, so a busy-wait loop
   * can never terminate here — induce real delay with `Atomics.wait`.
   */
  async function advanceUntil(
    condition: () => boolean,
    what: string,
    budgetMs = 10_000,
    stepMs = 50,
  ): Promise<void> {
    // Advance at most `budgetMs` in total. The final step is clamped to the
    // remainder so the helper cannot overshoot its own stated bound for a
    // `stepMs` that does not divide `budgetMs` — a helper that advertises a
    // limit and then exceeds it is the same class of lie this suite exists to
    // remove.
    let advancedMs = 0;
    while (advancedMs < budgetMs) {
      if (condition()) return;
      const step = Math.min(stepMs, budgetMs - advancedMs);
      await vi.advanceTimersByTimeAsync(step);
      advancedMs += step;
    }
    if (condition()) return;
    throw new Error(
      `${what} did not occur within ${budgetMs}ms of fake time (advanced ${advancedMs}ms)`,
    );
  }

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
    options: { resolveOriginalDelivery?: boolean; suffix?: string; replaySafe?: boolean } = {},
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
    const envelope = replayEnvelope(suffix, {
      sourceMessageId: `wamid-brick-source-${suffix}`,
      replaySafe: options.replaySafe ?? true,
    });
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
      // The real admission gate's typed error (turn-admission-errors.ts) —
      // constructing it here keeps this simulation from desynchronizing if
      // the production message ever changes.
      throw new ScopeBlockedByDurableRecoveryError();
    }
  }

  it('advanceUntil never advances past the budget it advertises, for any step size', async () => {
    vi.useFakeTimers();
    try {
      // A step that does NOT divide the budget is the case an `elapsed <= budget`
      // loop gets wrong: it takes one step too many and overshoots the bound it
      // just claimed in its own error message.
      const start = Date.now();
      let thrown: Error | null = null;
      await advanceUntil(() => false, 'never-satisfied condition', 1_000, 300)
        .catch((err: Error) => { thrown = err; });
      const advanced = Date.now() - start;

      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain('never-satisfied condition');
      expect(advanced).toBeLessThanOrEqual(1_000);

      // And it must actually exhaust the budget rather than give up early —
      // otherwise "not observed" would be indistinguishable from "not waited".
      expect(advanced).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('dispatches an evidence-promoted blocked_unsafe job while a never-promoted one stays blocked (#2155)', async () => {
    const promoted = crashOneSourceTurn({ suffix: 'promoted', replaySafe: false });
    const unpromoted = crashOneSourceTurn({ suffix: 'unpromoted', replaySafe: false });
    expect(durability.getTurnRecoveryJob(promoted.jobId)).toMatchObject({
      state: 'blocked_unsafe', replay_safe: 0, replay_safety_proof_id: null,
    });

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
        durability.completeInbound(promoted.sourceInboundSeq, 'response_sent');
        return { kind: 'delivered' };
      },
    });

    // Blocked-unsafe work never auto-replays: a scan touches neither job.
    const preScan = await supervisor.scanOnce();
    expect(preScan.claimed).toBe(0);
    expect(dispatchCalls).toBe(0);
    expect(durability.getTurnRecoveryJob(promoted.jobId)?.state).toBe('blocked_unsafe');

    // Operator promotion through the fenced store transition: state flips to
    // pending, the proof reference is recorded, replay_safe stays immutably 0.
    const promotion = durability.promoteBlockedTurnRecoveryJob(
      promoted.jobId,
      OWNER,
      { claimEpoch: 0, assignmentEpoch: 0 },
      { idempotencyProofId: 'proof:ambiguity-resolved:v1' },
    );
    expect(promotion).toMatchObject({ applied: true, state: 'pending' });
    expect(durability.getTurnRecoveryJob(promoted.jobId)).toMatchObject({
      state: 'pending', replay_safe: 0, replay_safety_proof_id: 'proof:ambiguity-resolved:v1',
    });

    // The shared eligibility contract dispatches the proof-promoted job and
    // ONLY that job: the never-promoted sibling remains blocked_unsafe.
    const scan = await supervisor.scanOnce();
    expect(scan.claimed).toBe(1);
    expect(scan.completed).toBe(1);
    expect(dispatchCalls).toBe(1);
    expect(durability.getTurnRecoveryJob(promoted.jobId)?.state).toBe('completed');
    expect(durability.getTurnRecoveryJob(unpromoted.jobId)).toMatchObject({
      state: 'blocked_unsafe', replay_safe: 0, replay_safety_proof_id: null,
    });

    // Terminal blocked work does not wedge the scope (#1760): admission is
    // open even though the never-promoted job remains retained for operators.
    expect(() => attemptAdmission('per_chat', promoted.conversationKey)).not.toThrow();
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

  it('leaves a job unclaimed until one generation-bound dispatch target is resolved, then threads that exact target to replay', async () => {
    const { jobId, sourceInboundSeq } = crashOneSourceTurn({ suffix: 'dispatch-target' });
    const target = {
      scope: 'per_chat',
      mapKey: 'scope-key',
      managerId: 'session-manager',
      generation: 7,
      session: {},
    } satisfies TurnRecoveryDispatchTarget;
    let resolvedTarget: TurnRecoveryDispatchTarget | null = null;
    const dispatchReplay = vi.fn(
      async (
        _job: unknown,
        _fence: unknown,
        receivedTarget?: TurnRecoveryDispatchTarget,
      ): Promise<TurnRecoveryReplayDispatchResult> => {
        expect(receivedTarget).toBe(target);
        durability.completeInbound(sourceInboundSeq, 'response_sent');
        return { kind: 'delivered' };
      },
    );
    const supervisor = new TurnRecoverySupervisor({
      instanceName: 'test-instance',
      durability: () => durability,
      freshOwnerIdentity: () => ({
        logicalTurnId: 'recovery-owner',
        managerId: 'recovery-manager',
        generation: 1,
      }),
      resolveDispatchTarget: () => resolvedTarget,
      dispatchReplay,
    });

    const skipped = await supervisor.scanOnce();
    expect(skipped).toMatchObject({
      claimed: 0,
      skippedNotDispatchable: 1,
    });
    expect(durability.getTurnRecoveryJob(jobId)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });
    expect(dispatchReplay).not.toHaveBeenCalled();

    resolvedTarget = target;
    const dispatched = await supervisor.scanOnce();
    expect(dispatched).toMatchObject({ claimed: 1, completed: 1 });
    expect(dispatchReplay).toHaveBeenCalledTimes(1);
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
      const originalRenew = durability.renewTurnRecoveryClaim.bind(durability);
      const renewSpy = vi.spyOn(durability, 'renewTurnRecoveryClaim');
      const renewAtMs: number[] = [];
      renewSpy.mockImplementation((renewJobId, owner, fence, options) => {
        renewAtMs.push(Date.now());
        return {
          ...originalRenew(renewJobId, owner, fence, options),
          claimExpiresAt: new Date(Date.now() + 3_000).toISOString(),
        };
      });

      // Deferred, not a real setTimeout: the dispatch "completes" only when
      // this test explicitly releases it, after fake time has been advanced
      // past the renewal interval — proves renewal fires WHILE dispatch is
      // still pending, not merely that it could fire eventually.
      let resolveDispatch: () => void = () => {};
      const dispatchGate = new Promise<void>((resolve) => { resolveDispatch = resolve; });

      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'brick-instance',
        durability: () => durability,
        // leaseSeconds=3 requests a 3000ms lease, but do NOT read the
        // schedule off that nominal figure: the store records the expiry with
        // SQLite's `datetime('now', ?)`, which truncates to whole seconds, so
        // the lease actually held is up to ~1s shorter (measured 2773ms on one
        // local run). Production schedules the first renewal at half the
        // RECORDED remaining time, so the real margin varies run to run.
        // `leaseDeadlines()` reads that recorded value; assert against it
        // rather than against 3000/1500.
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
      const lease = leaseDeadlines(jobId, 3);
      await advanceUntil(() => renewSpy.mock.calls.length >= 1, 'first lease renewal');

      // Renewal must land with margin INSIDE the lease it holds, not merely
      // "eventually" — otherwise the claim could lapse mid-replay and a second
      // owner could pick the same job up.
      expect(renewAtMs[0]).toBeLessThanOrEqual(lease.safetyDeadlineMs);
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

  it('retries a transient renewal failure and resumes successful renewal while dispatch remains pending', async () => {
    vi.useFakeTimers();
    try {
      const { jobId, sourceInboundSeq } = crashOneSourceTurn({ suffix: 'lease-transient' });
      const originalRenew = durability.renewTurnRecoveryClaim.bind(durability);
      const renewAtMs: number[] = [];
      const renewSpy = vi.spyOn(durability, 'renewTurnRecoveryClaim')
        .mockImplementationOnce(() => {
          renewAtMs.push(Date.now());
          throw new Error('temporary store availability failure');
        })
        .mockImplementation((renewJobId, owner, fence, options) => {
          renewAtMs.push(Date.now());
          return {
            ...originalRenew(renewJobId, owner, fence, options),
            claimExpiresAt: new Date(Date.now() + 3_000).toISOString(),
          };
        });
      let resolveDispatch: () => void = () => {};
      const dispatchGate = new Promise<void>((resolve) => { resolveDispatch = resolve; });
      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'brick-instance',
        durability: () => durability,
        leaseSeconds: 3,
        freshOwnerIdentity: () => ({
          logicalTurnId: 'brick-recovery-owner-transient',
          managerId: 'brick-supervisor',
          generation: 1,
        }),
        dispatchReplay: async () => {
          await dispatchGate;
          durability.completeInbound(sourceInboundSeq, 'response_sent');
          return { kind: 'delivered' };
        },
      });

      const scan = supervisor.scanOnce();
      const lease = leaseDeadlines(jobId, 3);
      await advanceUntil(() => renewSpy.mock.calls.length >= 2, 'renewal retry after transient failure');

      // Both the failed attempt and the retry that recovers it must fall inside
      // the safety margin — a retry that slips past it has already lost the lease.
      expect(renewAtMs[0]).toBeLessThanOrEqual(lease.safetyDeadlineMs);
      expect(renewAtMs[1]).toBeLessThanOrEqual(lease.safetyDeadlineMs);

      expect(renewSpy).toHaveBeenCalledTimes(2);
      expect(supervisor.health()).toMatchObject({
        leaseRenewals: 1,
        leaseRenewalFailures: 1,
        renewalRetryableFailures: 1,
      });

      resolveDispatch();
      expect(await scan).toMatchObject({ completed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts on confirmed claim-fence loss and never completes or requeues through the stale fence', async () => {
    vi.useFakeTimers();
    try {
      const { jobId } = crashOneSourceTurn({ suffix: 'lease-fence-lost' });
      vi.spyOn(durability, 'renewTurnRecoveryClaim').mockImplementation(() => {
        throw new TurnRecoveryClaimFenceError('claim owner changed');
      });
      let abortAtMs: number | null = null;
      const abort = vi.fn(async () => {
        abortAtMs ??= Date.now();
        return true;
      });
      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'brick-instance',
        durability: () => durability,
        leaseSeconds: 3,
        freshOwnerIdentity: () => ({
          logicalTurnId: 'brick-recovery-owner-fence-lost',
          managerId: 'brick-supervisor',
          generation: 1,
        }),
        dispatchReplay: (
          _job,
          _fence,
          _target,
          control?: TurnRecoveryReplayAbortControl,
        ) => {
          control!.registerAbort(abort);
          return new Promise<TurnRecoveryReplayDispatchResult>(() => {});
        },
      });

      const scan = supervisor.scanOnce();
      const lease = leaseDeadlines(jobId, 3);
      await advanceUntil(() => abort.mock.calls.length > 0, 'cooperative replay abort');

      // "Before expiry" is the invariant this test is named for: the guard must
      // give up its replay with margin to spare, not merely at some point.
      expect(abortAtMs).not.toBeNull();
      expect(abortAtMs!).toBeLessThanOrEqual(lease.safetyDeadlineMs);
      expect(abortAtMs!).toBeLessThan(lease.expiresAtMs);
      const result = await scan;

      expect(abort).toHaveBeenCalledWith('claim_fence_lost');
      expect(result).toMatchObject({ claimed: 1, completed: 0, requeued: 0 });
      expect(durability.getTurnRecoveryJob(jobId)?.state).toBe('claimed');
      expect(supervisor.health()).toMatchObject({
        renewalOwnershipLosses: 1,
        renewalFailClosedAborts: 1,
        renewalAbortFailures: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts before expiry after repeated transient renewal failures and requeues only through the live fence', async () => {
    vi.useFakeTimers();
    try {
      const { jobId } = crashOneSourceTurn({ suffix: 'lease-retry-exhausted' });
      vi.spyOn(durability, 'renewTurnRecoveryClaim').mockImplementation(() => {
        throw new Error('store remains unavailable');
      });
      let resolveAbort: (proven: boolean) => void = () => {};
      const abortGate = new Promise<boolean>((resolve) => { resolveAbort = resolve; });
      let abortAtMs: number | null = null;
      const abort = vi.fn(async () => {
        abortAtMs ??= Date.now();
        return abortGate;
      });
      let resolveDispatch: () => void = () => {};
      const dispatchGate = new Promise<void>((resolve) => { resolveDispatch = resolve; });
      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'brick-instance',
        durability: () => durability,
        leaseSeconds: 3,
        freshOwnerIdentity: () => ({
          logicalTurnId: 'brick-recovery-owner-retry-exhausted',
          managerId: 'brick-supervisor',
          generation: 1,
        }),
        dispatchReplay: async (_job, _fence, _target, control) => {
          control!.registerAbort(abort);
          await dispatchGate;
          return { kind: 'retryable_failure' };
        },
      });

      const scan = supervisor.scanOnce();
      const lease = leaseDeadlines(jobId, 3);
      await advanceUntil(() => abort.mock.calls.length > 0, 'cooperative replay abort');

      // "Before expiry" is the invariant this test is named for: the guard must
      // give up its replay with margin to spare, not merely at some point.
      expect(abortAtMs).not.toBeNull();
      expect(abortAtMs!).toBeLessThanOrEqual(lease.safetyDeadlineMs);
      expect(abortAtMs!).toBeLessThan(lease.expiresAtMs);
      expect(abort).toHaveBeenCalledWith('renewal_unavailable');
      expect(durability.getTurnRecoveryJob(jobId)?.state).toBe('claimed');
      let scanSettled = false;
      void scan.finally(() => { scanSettled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(scanSettled).toBe(false);

      resolveDispatch();
      await vi.advanceTimersByTimeAsync(0);
      expect(scanSettled).toBe(false);
      expect(durability.getTurnRecoveryJob(jobId)?.state).toBe('claimed');

      resolveAbort(true);
      await vi.advanceTimersByTimeAsync(0);
      const result = await scan;

      expect(result).toMatchObject({ claimed: 1, completed: 0, requeued: 1 });
      expect(durability.getTurnRecoveryJob(jobId)?.state).toBe('pending');
      expect(supervisor.health()).toMatchObject({
        renewalRetryableFailures: expect.any(Number),
        renewalFailClosedAborts: 1,
        renewalAbortFailures: 0,
      });
      expect(supervisor.health().renewalRetryableFailures).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records an unproven abort distinctly and makes no completion or requeue claim', async () => {
    vi.useFakeTimers();
    try {
      const { jobId } = crashOneSourceTurn({ suffix: 'lease-abort-failed' });
      vi.spyOn(durability, 'renewTurnRecoveryClaim').mockImplementation(() => {
        throw new TurnRecoveryClaimFenceError('claim owner changed');
      });
      let abortAtMs: number | null = null;
      const abort = vi.fn(async () => {
        abortAtMs ??= Date.now();
        return false;
      });
      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'brick-instance',
        durability: () => durability,
        leaseSeconds: 3,
        freshOwnerIdentity: () => ({
          logicalTurnId: 'brick-recovery-owner-abort-failed',
          managerId: 'brick-supervisor',
          generation: 1,
        }),
        dispatchReplay: (_job, _fence, _target, control) => {
          control!.registerAbort(abort);
          return new Promise<TurnRecoveryReplayDispatchResult>(() => {});
        },
      });

      const scan = supervisor.scanOnce();
      const lease = leaseDeadlines(jobId, 3);
      await advanceUntil(() => abort.mock.calls.length > 0, 'cooperative replay abort');

      // "Before expiry" is the invariant this test is named for: the guard must
      // give up its replay with margin to spare, not merely at some point.
      expect(abortAtMs).not.toBeNull();
      expect(abortAtMs!).toBeLessThanOrEqual(lease.safetyDeadlineMs);
      expect(abortAtMs!).toBeLessThan(lease.expiresAtMs);
      const result = await scan;

      expect(result).toMatchObject({ claimed: 1, completed: 0, requeued: 0 });
      expect(durability.getTurnRecoveryJob(jobId)?.state).toBe('claimed');
      expect(supervisor.health()).toMatchObject({
        renewalFailClosedAborts: 0,
        renewalAbortFailures: 1,
      });
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

  // #2819: the deadman's staleness budget must be validated against how long
  // a REAL scan can legitimately take, not just against a hand-built health
  // snapshot (tests/runtimes/agent/turn-recovery-deadman.test.ts already
  // covers the alerting path with synthetic snapshots; these two prove the
  // BUDGET against a real supervisor driving a real multi-job scan through
  // real durability, using PRODUCTION TurnRecoveryDeadman defaults — no
  // staleAfterMs/startupGraceMs override, exactly as runtime.ts wires it).
  describe('TurnRecoveryDeadman staleness budget (#2819)', () => {
    // The exact pre-#2819 constants, kept here (not imported) so this test
    // still proves the regression even after the source no longer exports
    // them: constructing a deadman with these literal values must ALWAYS
    // reproduce the false positive, regardless of what the fixed defaults
    // derive to.
    const PRE_FIX_STALE_AFTER_MS = 45_000;
    const PRE_FIX_STARTUP_GRACE_MS = 45_000;

    /**
     * Read-and-clear a dispatch gate's release function. An object-property
     * indirection (not a plain closured `let`) so TS's control-flow narrowing
     * — which otherwise loses track of the non-null assignment happening
     * inside the async dispatchReplay closure across loop iterations — never
     * gets a chance to (mis)narrow this to `never`. Throws instead of a bare
     * non-null assertion: a real timing bug here should fail loud, not
     * silently invoke `undefined`.
     */
    function takeGateRelease(gate: { release: (() => void) | null }): () => void {
      const release = gate.release;
      gate.release = null;
      if (release === null) throw new Error('dispatch gate has no pending release — test timing assumption broke');
      return release;
    }

    it('a post-crash backlog of a full scan page, each replay taking ~1s, does not false-alarm during the startup grace window', async () => {
      vi.useFakeTimers();
      try {
        const inboundSeqByJobId = new Map<number, number>();
        for (let i = 0; i < SCAN_PAGE_SIZE; i += 1) {
          const seeded = crashOneSourceTurn({ suffix: `backlog-${i}` });
          inboundSeqByJobId.set(seeded.jobId, seeded.sourceInboundSeq);
        }

        // Jobs in a scan page are awaited strictly sequentially (the
        // fair-scheduling loop in runScan()), so at most one dispatchReplay
        // call is ever in flight — a single "current gate" reference is
        // enough. Deferred, not a real setTimeout: each job's dispatch
        // "completes" only when the test explicitly releases it, after fake
        // time has been advanced by its simulated ~1s duration (mirrors the
        // dispatchGate pattern in the lease-renewal tests above).
        const currentDispatchGate: { release: (() => void) | null } = { release: null };
        const supervisor = new TurnRecoverySupervisor({
          instanceName: 'brick-instance',
          durability: () => durability,
          freshOwnerIdentity: () => ({
            logicalTurnId: 'brick-recovery-owner-backlog',
            managerId: 'brick-supervisor',
            generation: 1,
          }),
          dispatchReplay: async (job): Promise<TurnRecoveryReplayDispatchResult> => {
            await new Promise<void>((resolve) => { currentDispatchGate.release = resolve; });
            durability.completeInbound(inboundSeqByJobId.get(job.id)!, 'response_sent');
            return { kind: 'delivered' };
          },
        });

        const emitAlertFixed = vi.fn(() => true);
        const deadmanFixed = new TurnRecoveryDeadman({
          instanceName: 'brick-instance',
          enabled: () => true,
          health: () => supervisor.health(),
          emitAlert: emitAlertFixed,
          clearAlert: vi.fn(() => true),
          // No staleAfterMs/startupGraceMs override: exercises the PRODUCTION
          // defaults derived from DEFAULT_LEASE_SECONDS.
        });
        const emitAlertPreFix = vi.fn(() => true);
        const deadmanPreFix = new TurnRecoveryDeadman({
          instanceName: 'brick-instance',
          enabled: () => true,
          health: () => supervisor.health(),
          emitAlert: emitAlertPreFix,
          clearAlert: vi.fn(() => true),
          staleAfterMs: PRE_FIX_STALE_AFTER_MS,
          startupGraceMs: PRE_FIX_STARTUP_GRACE_MS,
        });

        deadmanFixed.start();
        deadmanPreFix.start();
        const scanPromise = supervisor.scanOnce();
        // Drive the full page's worth of ~1s-per-job sequential dispatches:
        // flush microtasks so this iteration's dispatchReplay call has
        // registered its gate, advance fake time by its simulated ~1s
        // duration (the realistic per-job duration named in #2819's
        // evidence — "a post-crash backlog of 50 queued jobs at ~1s each"),
        // then release exactly that job's gate before the next one starts.
        for (let i = 0; i < SCAN_PAGE_SIZE; i += 1) {
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(1_000);
          takeGateRelease(currentDispatchGate)();
        }
        // Margin for the deadman's own 15s check cadence to tick at least
        // once more after the scan's genuine completion.
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await scanPromise;
        expect(result.completed).toBe(SCAN_PAGE_SIZE);

        // GREEN: production-derived budget never false-alarms during the
        // backlog's legitimate processing time.
        expect(emitAlertFixed).not.toHaveBeenCalled();
        // RED: the OLD 45s budget WOULD have false-alarmed `never_succeeded`
        // partway through the exact same real scan — proving #2819 was a
        // real defect in the constants, not just a hypothetical one.
        expect(emitAlertPreFix).toHaveBeenCalledWith(
          'brick-instance',
          'turn_recovery_supervisor_unavailable',
          'Turn-recovery supervisor unavailable',
          expect.stringMatching(/^reason=never_succeeded/),
          'critical',
        );

        deadmanFixed.stop();
        deadmanPreFix.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a single legitimately slow replay spanning well past the old 45s budget does not false-alarm stale_success once the supervisor has an established healthy history', async () => {
      vi.useFakeTimers();
      try {
        // Mutable, assigned only once the slow job is actually seeded below —
        // dispatchReplay is never invoked before then (the first scanOnce()
        // call has zero outstanding jobs), so reading it late is safe. Using
        // ONE supervisor instance (not two) throughout is the point: its
        // internal lastSuccessfulScanAt must carry over from the first,
        // trivial, successful scan into the second, slow one — that IS "an
        // established healthy history going stale", not a cold start (the
        // cold-start/startup-grace path is the sibling test above).
        let sourceInboundSeq: number | undefined;
        // Deferred, not a real setTimeout: the dispatch "completes" only when
        // the test explicitly releases it, after fake time has been advanced
        // by the simulated ~90s duration (mirrors the dispatchGate pattern in
        // the lease-renewal tests above).
        const dispatchGate: { release: (() => void) | null } = { release: null };
        const supervisor = new TurnRecoverySupervisor({
          instanceName: 'brick-instance',
          durability: () => durability,
          freshOwnerIdentity: () => ({
            logicalTurnId: 'brick-recovery-owner-slow',
            managerId: 'brick-supervisor',
            generation: 1,
          }),
          // DEFAULT_LEASE_SECONDS (120s) is left at its production default
          // (not overridden) so real lease-renewal timing applies.
          dispatchReplay: async (): Promise<TurnRecoveryReplayDispatchResult> => {
            await new Promise<void>((resolve) => { dispatchGate.release = resolve; });
            durability.completeInbound(sourceInboundSeq!, 'response_sent');
            return { kind: 'delivered' };
          },
        });
        await supervisor.scanOnce(); // zero outstanding jobs yet: a trivial success

        const seeded = crashOneSourceTurn({ suffix: 'slow-replay' });
        sourceInboundSeq = seeded.sourceInboundSeq;

        const emitAlertFixed = vi.fn(() => true);
        const deadmanFixed = new TurnRecoveryDeadman({
          instanceName: 'brick-instance',
          enabled: () => true,
          health: () => supervisor.health(),
          emitAlert: emitAlertFixed,
          clearAlert: vi.fn(() => true),
        });
        const emitAlertPreFix = vi.fn(() => true);
        const deadmanPreFix = new TurnRecoveryDeadman({
          instanceName: 'brick-instance',
          enabled: () => true,
          health: () => supervisor.health(),
          emitAlert: emitAlertPreFix,
          clearAlert: vi.fn(() => true),
          staleAfterMs: PRE_FIX_STALE_AFTER_MS,
          startupGraceMs: PRE_FIX_STARTUP_GRACE_MS,
        });

        deadmanFixed.start();
        deadmanPreFix.start();
        const scanPromise = supervisor.scanOnce();
        // Flush the synchronous claim -> dispatchReplay() call chain so the
        // gate is registered, then advance fake time by the simulated ~90s
        // duration (comfortably exceeds the 60s half-lease renewal interval
        // named in #2819 while staying under one full DEFAULT_LEASE_SECONDS
        // (120s) lease — this also drives the supervisor's own real
        // lease-renewal timer, production code, not a test-side sleep).
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(90_000);
        takeGateRelease(dispatchGate)();
        // Margin for the deadman's own check cadence to tick at least once
        // more after the scan's genuine completion.
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await scanPromise;
        expect(result.completed).toBe(1);

        // GREEN: production-derived budget survives a single ~90s replay.
        expect(emitAlertFixed).not.toHaveBeenCalled();
        // RED: the OLD 45s budget WOULD have false-alarmed `stale_success`
        // against the SAME real, healthy, still-in-flight scan.
        expect(emitAlertPreFix).toHaveBeenCalledWith(
          'brick-instance',
          'turn_recovery_supervisor_unavailable',
          'Turn-recovery supervisor unavailable',
          expect.stringMatching(/^reason=stale_success/),
          'critical',
        );

        deadmanFixed.stop();
        deadmanPreFix.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('TurnRecoverySupervisor — successful scan watermark', () => {
  function durabilityForHealth(
    overrides: Partial<TurnRecoverySupervisorDurability> = {},
  ): TurnRecoverySupervisorDurability {
    return {
      getOutstandingTurnRecoveryJobsForSupervisor: () => ({
        jobs: [],
        nextCursor: null,
        scanComplete: true,
      }),
      claimTurnRecoveryJob: vi.fn(),
      renewTurnRecoveryClaim: vi.fn(),
      completeTurnRecoveryJob: vi.fn(),
      requeueTurnRecoveryJob: vi.fn(),
      reassignPendingTurnRecoveryJob: vi.fn(),
      getTurnRecoverySupervisorCounts: () => ({
        outstanding: 0,
        pending: 0,
        liveClaimed: 0,
        expiredClaimed: 0,
        blockedUnsafe: 0,
        exhausted: 0,
        quarantinedDelivery: 0,
        corruptLinks: 0,
        orphanTransfers: 0,
        echoConflicts: 0,
        openRecoveries: 0,
      }),
      recoverStaleTurnRecoveryJobs: () => ({ requeued: 0, exhausted: 0 }),
      getTurnRecoveryOriginalDeliveryStatus: vi.fn(),
      getTurnRecoverySourceProof: vi.fn(),
      ...overrides,
    };
  }

  it('does not refresh successful liveness when durable enumeration throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const durability = durabilityForHealth({
        getOutstandingTurnRecoveryJobsForSupervisor: () => {
          throw new Error('store unavailable');
        },
      });
      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'test-instance',
        durability: () => durability,
        freshOwnerIdentity: () => ({
          logicalTurnId: 'recovery-owner',
          managerId: 'recovery-manager',
          generation: 1,
        }),
        dispatchReplay: async () => ({ kind: 'retryable_failure' }),
      });

      await expect(supervisor.scanOnce()).rejects.toThrow('store unavailable');
      expect(supervisor.health()).toMatchObject({
        lastScanAttemptAt: 1_000_000,
        lastSuccessfulScanAt: null,
        consecutiveScanFailures: 1,
        lastScanFailureReason: 'enumeration_failed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a stale-claim sweep exception as a failed scan, then clears failure state after success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    try {
      let failSweep = true;
      const durability = durabilityForHealth({
        recoverStaleTurnRecoveryJobs: () => {
          if (failSweep) throw new Error('store unavailable');
          return { requeued: 0, exhausted: 0 };
        },
      });
      const supervisor = new TurnRecoverySupervisor({
        instanceName: 'test-instance',
        durability: () => durability,
        freshOwnerIdentity: () => ({
          logicalTurnId: 'recovery-owner',
          managerId: 'recovery-manager',
          generation: 1,
        }),
        dispatchReplay: async () => ({ kind: 'retryable_failure' }),
      });

      await supervisor.scanOnce();
      expect(supervisor.health()).toMatchObject({
        lastSuccessfulScanAt: null,
        consecutiveScanFailures: 1,
        lastScanFailureReason: 'stale_claim_recovery_failed',
      });

      failSweep = false;
      vi.setSystemTime(2_015_000);
      await supervisor.scanOnce();
      expect(supervisor.health()).toMatchObject({
        lastScanAttemptAt: 2_015_000,
        lastSuccessfulScanAt: 2_015_000,
        consecutiveScanFailures: 0,
        lastScanFailureReason: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TurnRecoverySupervisor — deadman heartbeat evaluation', () => {
  it('flags an unhealthy heartbeat when the supervisor has never scanned', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: null,
        lastScanAttemptAt: null,
        lastSuccessfulScanAt: null,
        consecutiveScanFailures: 0,
        lastScanFailureReason: null,
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
        renewalRetryableFailures: 0,
        renewalOwnershipLosses: 0,
        renewalFailClosedAborts: 0,
        renewalAbortFailures: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: false, reason: 'never_succeeded' });
  });

  it('flags an unhealthy heartbeat when the last successful scan is older than the stale threshold', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: 1_000_000 - 120_000,
        lastScanAttemptAt: 1_000_000 - 5_000,
        lastSuccessfulScanAt: 1_000_000 - 120_000,
        consecutiveScanFailures: 1,
        lastScanFailureReason: 'enumeration_failed',
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
        renewalRetryableFailures: 0,
        renewalOwnershipLosses: 0,
        renewalFailClosedAborts: 0,
        renewalAbortFailures: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: false, reason: 'stale_success' });
  });

  it('reports unhealthy after repeated failures even while the last success is fresh', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: 1_000_000 - 1_000,
        lastScanAttemptAt: 1_000_000 - 1_000,
        lastSuccessfulScanAt: 1_000_000 - 5_000,
        consecutiveScanFailures: 3,
        lastScanFailureReason: 'enumeration_failed',
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
        renewalRetryableFailures: 0,
        renewalOwnershipLosses: 0,
        renewalFailClosedAborts: 0,
        renewalAbortFailures: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000, maxConsecutiveFailures: 3 },
    );
    expect(verdict).toMatchObject({ healthy: false, reason: 'repeated_failures' });
  });

  it('reports healthy when the last successful scan is within the stale threshold', () => {
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(
      {
        lastScanAt: 1_000_000 - 5_000,
        lastScanAttemptAt: 1_000_000 - 5_000,
        lastSuccessfulScanAt: 1_000_000 - 5_000,
        consecutiveScanFailures: 0,
        lastScanFailureReason: null,
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
        renewalRetryableFailures: 0,
        renewalOwnershipLosses: 0,
        renewalFailClosedAborts: 0,
        renewalAbortFailures: 0,
        storeCounts: null,
      },
      { nowMs: 1_000_000, staleAfterMs: 60_000 },
    );
    expect(verdict).toMatchObject({ healthy: true, reason: 'ok' });
  });
});
