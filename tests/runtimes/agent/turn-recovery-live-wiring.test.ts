/**
 * PRESTAGE-T4 PR1 merge gate (boterr-lead ruling): the 66-unit-test suite in
 * turn-recovery-supervisor.test.ts uses an INJECTED FAKE dispatchReplay — it
 * proves the supervisor's own logic and the excludeJobId SQL are correct,
 * but proves NOTHING about whether the real runtime.ts wiring
 * (dispatchTurnRecoveryReplay -> processPerChatTurn -> sendTurnPerChat ->
 * beginRuntimeTurnEvidence) actually threads job.id through end-to-end.
 * That is exactly the class of false-green this lane's
 * real-data-check-beats-green-suite rule exists to catch.
 *
 * This file exercises the REAL `AgentRuntime.dispatchTurnRecoveryReplay`
 * (private; reached via a narrow cast, same technique the shared harness
 * already uses for other private coordinator internals) against a REAL,
 * unmocked `DurabilityEngine` over a real in-memory SQLite database — not
 * `durabilityMock()`. A session/queue STUB is injected directly into
 * `chatSessions`/`chatQueues` (bypassing real subprocess spawning, which is
 * out of scope for this proof) and turn completion is driven by resolving
 * the exposed `perChatRuntimeTurnCompletions` entry directly rather than
 * simulating full provider stream events — legitimate because the thing
 * under test is the ADMISSION/threading step, which happens synchronously
 * before completion, not the provider round-trip itself.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { TurnRecoveryClaimFence, TurnRecoveryJobRow } from '../../../src/core/turn-recovery-store.ts';
import type {
  TurnRecoveryDispatchTarget,
  TurnRecoveryReplayAbortControl,
  TurnRecoveryReplayAbortReason,
  TurnRecoveryReplayDispatchResult,
} from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../../src/runtimes/agent/turn-terminal.ts';
import {
  makeRuntimeState,
  queueStub,
  sessionStub,
  type RuntimeState,
} from './lib/runtime-terminal-coordinator-harness.ts';
import type { RuntimeTurnCompletion } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';

// Narrow view onto the private members this proof needs. Same technique the
// shared harness already uses (RuntimeState casts AgentRuntime to an
// interface exposing exactly the private surface each test file needs).
// perChatRuntimeTurnCompletions is not on the shared RuntimeState (not
// needed by the existing coordinator-integration suite) so it is added here.
interface LiveWiringRuntimeState extends RuntimeState {
  dispatchTurnRecoveryReplay(
    job: TurnRecoveryJobRow,
    fence: TurnRecoveryClaimFence,
    target?: TurnRecoveryDispatchTarget,
    abortControl?: TurnRecoveryReplayAbortControl,
  ): Promise<TurnRecoveryReplayDispatchResult>;
  perChatRuntimeTurnCompletions: Map<string, RuntimeTurnCompletion>;
  // requireSessionToolScopeKey (runtime.ts:1069) reads this WeakMap, normally
  // populated only by the real session-spawn path (runtime.ts:11166). A
  // stub session injected directly into chatSessions was never spawned, so
  // it has no entry here — createRuntimeTurnForDispatch would otherwise
  // throw 'Cannot dispatch a runtime turn for an unregistered session
  // manager', caught by dispatchTurnRecoveryReplay's own try/catch and
  // silently returned as retryable_failure (found via a debug trace before
  // this fix, not guessed).
  sessionEventToolScopes: WeakMap<object, string>;
  turnRecoverySupervisor: {
    scanOnce(): Promise<{
      scanned: number;
      claimed: number;
      completed: number;
      requeued: number;
      skippedUnsupportedScope: number;
      skippedNotDispatchable: number;
    }>;
    stop(): void;
  };
  turnRecoveryDeadman: {
    health(): { running: boolean };
    stop(): void;
  };
}

const OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'live-wiring-source-turn',
  managerId: 'manager-source',
  generation: 3,
};

/**
 * Mirrors tests/runtimes/agent/turn-recovery-supervisor.test.ts's fixture.
 * `scope` is set at creation, not mutated after: turn_recovery_jobs has a
 * DB trigger (database-migrations-37-40.ts) that RAISE(ABORT)s on any UPDATE
 * touching scope/conversation_key/delivery_jid/etc — the envelope is
 * immutable by design, so a shared/singleton-scope fixture must be created
 * with that scope from the start, not hand-flipped via UPDATE.
 */
function crashOneSourceTurn(
  db: Database,
  durability: DurabilityEngine,
  mapKey: string,
  suffix: string,
  scope: 'per_chat' | 'shared' | 'singleton' = 'per_chat',
): { jobId: number; conversationKey: string; deliveryJid: string; sourceInboundSeq: number } {
  const conversationKey = mapKey;
  const deliveryJid = `${mapKey}@s.whatsapp.net`;
  const inboundSeq = durability.journalInbound(`wamid-live-${suffix}`, conversationKey, deliveryJid, 'agent');
  const result: TurnTerminalResult = {
    identity: {
      scope,
      conversationKey,
      deliveryJid,
      inboundSeq,
      logicalTurnId: `turn-source-${suffix}`,
      managerId: 'manager-source',
      generation: 3,
    },
    attemptOutcome: { kind: 'failed', class: 'crash' },
    inboundDisposition: 'transferred_to_recovery_owner',
    deliveryEvidence: { kind: 'enqueued', opId: 0 },
  };
  const deliveryOpId = durability.createOutboundOp({
    conversationKey,
    chatJid: deliveryJid,
    opType: 'text',
    payload: JSON.stringify({ text: 'session terminated ... restarting' }),
    sourceInboundSeq: inboundSeq,
    replayPolicy: 'unsafe',
  });
  const finalResult: TurnTerminalResult = { ...result, deliveryEvidence: { kind: 'enqueued', opId: deliveryOpId } };
  const envelope: TurnRecoveryReplayEnvelope = {
    sourceMessageId: `wamid-live-${suffix}`,
    receivedAtUnixSeconds: 1_780_000_000,
    replaySafe: true,
    senderJid: '15550100002:9@s.whatsapp.net',
    senderName: 'Live Wiring Sender',
    text: 'Live wiring replay text',
    isGroup: false,
  };
  const params = {
    ...toTurnFinalizationPersistence(finalResult, OWNER),
    recoveryJob: toTurnRecoveryJobPersistence(finalResult, OWNER, envelope),
  };
  const receipt = durability.finalizeTurnTerminal(params);
  const jobId = receipt.recoveryJob!.jobId;

  durability.markSending(deliveryOpId);
  // #2079's reconciler already resolved the ambiguous original send by the
  // time the supervisor scans, same precondition as the supervisor tests.
  db.raw.prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE id = ?`).run(deliveryOpId);

  return { jobId, conversationKey, deliveryJid, sourceInboundSeq: inboundSeq };
}

describe('AgentRuntime.dispatchTurnRecoveryReplay — live wiring (PRESTAGE-T4 PR1 gate)', () => {
  let db: Database;
  let durability: DurabilityEngine;
  let runtime: ReturnType<typeof makeRuntimeState<LiveWiringRuntimeState>>['runtime'];
  let state: LiveWiringRuntimeState;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
    const built = makeRuntimeState<LiveWiringRuntimeState>(db, { sessionScope: 'per_chat' });
    runtime = built.runtime;
    state = built.state;
    runtime.setDurability(durability);
  });

  afterEach(async () => {
    await runtime.shutdown().catch(() => {});
    db.close();
  });

  it('(a)+(b) threads job.id into the REAL beginRuntimeTurnEvidence as excludeJobId, so the replay is admitted against the REAL store while its own claim is still outstanding', async () => {
    const conversationKeySeed = '15550190777';
    const { jobId, conversationKey, deliveryJid, sourceInboundSeq } = crashOneSourceTurn(db, durability, conversationKeySeed, 'ab');
    // resolvePerChatMapKey -> canonicalizeChatJid is IDENTITY for an
    // @s.whatsapp.net jid (no LID mapping registered here), so the map key
    // the runtime resolves internally IS the delivery jid itself, not the
    // bare digits used to build it.
    const mapKey = deliveryJid;

    // Prove the block is REAL first: an unrelated new inbound for this exact
    // scope, checked against the REAL (unmocked) store, is rejected while
    // the job sits pending/unclaimed.
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey)).toBe(true);

    // Claim it as the supervisor's claimAndReplay would, before calling
    // dispatchReplay — real store call, real fence.
    const owner = { logicalTurnId: OWNER.logicalTurnId, managerId: OWNER.managerId, generation: OWNER.generation };
    const claim = durability.claimTurnRecoveryJob(jobId, owner, { claimToken: 'live-wiring-claim', leaseSeconds: 120 });
    expect(claim.applied).toBe(true);
    const fence: TurnRecoveryClaimFence = { claimToken: claim.claimToken, claimEpoch: claim.claimEpoch };

    // Still blocked WITHOUT excludeJobId — the job is now genuinely claimed
    // (not just pending), so this is the exact self-block condition.
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey)).toBe(true);

    // Session/queue/ownership scaffolding: real AgentRuntime, stubbed
    // subprocess boundary only.
    const session = sessionStub();
    const managerId = state.managerIdFor(session);
    state.sessionOwnership.claim(mapKey, managerId);
    state.sessionOwnership.transition(mapKey, managerId, 'active');
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queueStub(deliveryJid));
    state.sessionEventToolScopes.set(session, mapKey);

    const job = durability.getTurnRecoveryJob(jobId)!;
    const dispatchPromise = state.dispatchTurnRecoveryReplay(job, fence);

    // Admission (beginRuntimeTurnEvidence with excludeJobId) happens
    // synchronously-ish inside sendTurnPerChat, before session.sendTurn is
    // awaited; once it succeeds, beginPerChatRuntimeTurn has registered a
    // completion for this mapKey. If admission instead threw (excludeJobId
    // NOT threaded — the regression this test exists to catch), dispatchReplay's
    // own try/catch swallows it into a fast-resolving retryable_failure and
    // no completion is ever registered — waitFor below would time out,
    // failing the test with a clear signal.
    await vi.waitFor(() => {
      expect(state.perChatRuntimeTurnCompletions.has(mapKey)).toBe(true);
    });

    // The REAL admission call happened without throwing — direct proof that
    // excludeJobId reached the REAL hasOutstandingTurnRecoveryForScope and
    // excluded this exact job (not a blanket bypass): the earlier assertion
    // proved the same scope+job WOULD block without it.
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey, { excludeJobId: jobId }))
      .toBe(false);

    // Drive the turn to completion directly (provider round-trip is out of
    // scope for this proof) and let dispatchReplay's own finalization run.
    durability.completeInbound(sourceInboundSeq, 'response_sent');
    state.perChatRuntimeTurnCompletions.get(mapKey)!.resolve();

    const outcome = await dispatchPromise;
    expect(outcome).toEqual({ kind: 'delivered' });
  });

  it('(c) both pre-claim skips fire on the REAL constructed supervisor instance, not a fresh test-only one', async () => {
    const supervisorState = state as unknown as LiveWiringRuntimeState;

    // Unsupported scope: a genuine shared-scope job, created as 'shared'
    // from the start (scope is immutable post-creation — see the fixture's
    // doc comment).
    crashOneSourceTurn(db, durability, '15550190778', 'shared-scope', 'shared');

    // Not dispatchable: a genuine per_chat job with NO live session — the
    // REAL isDispatchable closure built in AgentRuntime's constructor checks
    // state.chatSessions.has(mapKey), which is empty for this mapKey.
    crashOneSourceTurn(db, durability, '15550190779', 'no-session');

    const result = await supervisorState.turnRecoverySupervisor.scanOnce();
    expect(result.scanned).toBe(2);
    expect(result.skippedUnsupportedScope).toBe(1);
    expect(result.skippedNotDispatchable).toBe(1);
    expect(result.claimed).toBe(0);
  });

  it('admits only the exact active per-chat generation and leaves inactive or non-active mappings unclaimed', async () => {
    const inactive = crashOneSourceTurn(db, durability, '15550190784', 'inactive');
    const inactiveSession = sessionStub();
    inactiveSession.getStatus.mockReturnValue({
      active: false,
      sessionId: 'session-inactive',
      pid: null,
    });
    const inactiveManagerId = state.managerIdFor(inactiveSession);
    state.sessionOwnership.claim(inactive.deliveryJid, inactiveManagerId);
    state.sessionOwnership.transition(inactive.deliveryJid, inactiveManagerId, 'active');
    state.chatSessions.set(inactive.deliveryJid, inactiveSession);

    const starting = crashOneSourceTurn(db, durability, '15550190785', 'starting');
    const startingSession = sessionStub();
    const startingManagerId = state.managerIdFor(startingSession);
    state.sessionOwnership.claim(starting.deliveryJid, startingManagerId);
    state.chatSessions.set(starting.deliveryJid, startingSession);

    const skipped = await state.turnRecoverySupervisor.scanOnce();
    expect(skipped).toMatchObject({
      scanned: 2,
      claimed: 0,
      skippedNotDispatchable: 2,
    });
    expect(durability.getTurnRecoveryJob(inactive.jobId)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });
    expect(durability.getTurnRecoveryJob(starting.jobId)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });

    inactiveSession.getStatus.mockReturnValue({
      active: true,
      sessionId: 'session-active',
      pid: 4100,
    });
    state.chatQueues.set(inactive.deliveryJid, queueStub(inactive.deliveryJid));
    state.sessionEventToolScopes.set(inactiveSession, inactive.deliveryJid);

    const admitted = state.turnRecoverySupervisor.scanOnce();
    await vi.waitFor(() => {
      expect(state.perChatRuntimeTurnCompletions.has(inactive.deliveryJid)).toBe(true);
    });
    durability.completeInbound(inactive.sourceInboundSeq, 'response_sent');
    state.perChatRuntimeTurnCompletions.get(inactive.deliveryJid)!.resolve();

    expect(await admitted).toMatchObject({
      claimed: 1,
      completed: 1,
      skippedNotDispatchable: 1,
    });
    state.perChatRuntimeTurnCompletions.delete(inactive.deliveryJid);
    state.perChatRuntimeTurnContexts.delete(inactive.deliveryJid);
    state.perChatInboundSeqQueue.delete(inactive.deliveryJid);
  });

  it('revalidates the captured generation at the exact provider boundary before writing', async () => {
    const crashed = crashOneSourceTurn(db, durability, '15550190786', 'boundary-swap');
    const mapKey = crashed.deliveryJid;
    const session = sessionStub();
    const managerId = state.managerIdFor(session);
    state.sessionOwnership.claim(mapKey, managerId);
    state.sessionOwnership.transition(mapKey, managerId, 'active');
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queueStub(mapKey));
    state.sessionEventToolScopes.set(session, mapKey);

    const sendTurnAtProviderBoundary = vi.fn(async (
      input: unknown,
      onReady?: () => void,
    ) => {
      state.sessionOwnership.advanceGeneration(mapKey, managerId);
      onReady?.();
      await session.sendTurn(input);
    });
    Object.assign(session, { sendTurnAtProviderBoundary });

    const result = await state.turnRecoverySupervisor.scanOnce();

    expect(sendTurnAtProviderBoundary).toHaveBeenCalledTimes(1);
    expect(session.sendTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, requeued: 1, completed: 0 });
    expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
    expect(state.pendingTurnText.has(mapKey)).toBe(false);
  });

  it('cooperatively terminates the exact provider generation after the boundary before proving abort', async () => {
    const crashed = crashOneSourceTurn(db, durability, '15550190787', 'renewal-abort');
    const mapKey = crashed.deliveryJid;
    const owner = {
      logicalTurnId: OWNER.logicalTurnId,
      managerId: OWNER.managerId,
      generation: OWNER.generation,
    };
    const claimed = durability.claimTurnRecoveryJob(
      crashed.jobId,
      owner,
      { claimToken: 'live-wiring-abort-claim', leaseSeconds: 120 },
    );
    const fence: TurnRecoveryClaimFence = {
      claimToken: claimed.claimToken,
      claimEpoch: claimed.claimEpoch,
    };

    let active = true;
    let turnInFlight = true;
    let resolveProvider: () => void = () => {};
    const providerGate = new Promise<void>((resolve) => { resolveProvider = resolve; });
    const session = sessionStub();
    session.getStatus.mockImplementation(() => ({
      active,
      sessionId: active ? 'session-abort' : null,
      pid: active ? 4100 : null,
      turnInFlight,
    }));
    session.shutdown.mockImplementation(async () => {
      active = false;
      turnInFlight = false;
      resolveProvider();
    });
    Object.assign(session, {
      sendTurnAtProviderBoundary: vi.fn(async (_input: unknown, onReady?: () => void) => {
        onReady?.();
        await providerGate;
      }),
    });
    const managerId = state.managerIdFor(session);
    const generation = state.sessionOwnership.claim(mapKey, managerId).generation;
    state.sessionOwnership.transition(mapKey, managerId, 'active');
    state.chatSessions.set(mapKey, session);
    const queue = queueStub(mapKey);
    state.chatQueues.set(mapKey, queue);
    state.sessionEventToolScopes.set(session, mapKey);
    const target: TurnRecoveryDispatchTarget = {
      scope: 'per_chat',
      mapKey,
      managerId,
      generation,
      session,
    };

    let abortHandler:
      | ((reason: TurnRecoveryReplayAbortReason) => Promise<boolean>)
      | undefined;
    const controller = new AbortController();
    const control: TurnRecoveryReplayAbortControl = {
      signal: controller.signal,
      registerAbort: (handler) => { abortHandler = handler; },
    };
    const dispatch = state.dispatchTurnRecoveryReplay(
      durability.getTurnRecoveryJob(crashed.jobId)!,
      fence,
      target,
      control,
    );
    await vi.waitFor(() => {
      expect(state.perChatRuntimeTurnCompletions.has(mapKey)).toBe(true);
      expect(abortHandler).toBeTypeOf('function');
    });

    controller.abort('claim_fence_lost');
    expect(await abortHandler!('claim_fence_lost')).toBe(true);
    expect(session.shutdown).toHaveBeenCalledWith(false);
    expect(queue.abortTurn).toHaveBeenCalledWith({ preserveEvidence: true });
    expect(session.getStatus()).toMatchObject({
      active: false,
      pid: null,
      turnInFlight: false,
    });
    expect(await dispatch).toEqual({ kind: 'retryable_failure' });
  });

  it('(d) double-send fix: a replay whose OWN finalization defers (source inbound stays non-terminal) is requeued, not misreported delivered -- through the REAL wired supervisor, not a fake dispatchReplay', async () => {
    const { jobId, conversationKey, deliveryJid } = crashOneSourceTurn(db, durability, '15550190781', 'defer');
    const mapKey = deliveryJid;

    const session = sessionStub();
    const managerId = state.managerIdFor(session);
    state.sessionOwnership.claim(mapKey, managerId);
    state.sessionOwnership.transition(mapKey, managerId, 'active');
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queueStub(deliveryJid));
    state.sessionEventToolScopes.set(session, mapKey);

    // Drive claim+dispatch through the REAL constructed supervisor -- its
    // dispatchReplay is verifyProvenBeforeDelivered-wrapped
    // (turn-recovery-dispatch.ts). Calling state.dispatchTurnRecoveryReplay
    // directly, like (a)+(b) does, would bypass the fix entirely: the wrap
    // sits around the supervisor's OWN dispatchReplay callback, one level
    // above AgentRuntime.dispatchTurnRecoveryReplay itself.
    const supervisorState = state as unknown as LiveWiringRuntimeState;
    const scanPromise = supervisorState.turnRecoverySupervisor.scanOnce();

    await vi.waitFor(() => {
      expect(state.perChatRuntimeTurnCompletions.has(mapKey)).toBe(true);
    });

    // The replay's OWN finalization defers rather than proving delivery:
    // deliberately do NOT call durability.completeInbound -- this mirrors
    // toInboundMutation's actual behavior (no write at all) for a
    // transferred_to_recovery_owner disposition. Resolving the completion
    // directly is the same provider-round-trip-out-of-scope technique (a)+(b)
    // already uses; only the "did completeInbound run" axis differs here.
    state.perChatRuntimeTurnCompletions.get(mapKey)!.resolve();

    const scanResult = await scanPromise;

    // Pre-fix: this job is claimed then wrongly reported 'delivered',
    // completeTurnRecoveryJob throws on the non-terminal source inbound, and
    // it surfaces as a processing error with the job left claimed (exactly
    // the settling test's proven mechanism). Post-fix: verifyProvenBeforeDelivered
    // catches the unproven 'delivered' BEFORE completeTurnRecoveryJob is ever
    // called, reclassifies to retryable_failure, and the job requeues cleanly
    // through the ordinary bounded backoff path instead.
    expect(scanResult).toMatchObject({ claimed: 1, requeued: 1, completed: 0, processingErrors: 0 });

    const job = durability.getTurnRecoveryJob(jobId)!;
    expect(job.state).toBe('pending');
    expect(job.attempt_count).toBe(1);

    // The scope is genuinely blocked again (job J still outstanding, now
    // pending rather than silently expired-claimed) -- distinct from (a)+(b)'s
    // proven exclusion, this just confirms the requeue left real, visible,
    // tracked state rather than a zombie.
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey)).toBe(true);
  });

  it('(e) EXTENDED (boterr-lead required addition): once a genuine successor job (J2) completes the shared source, does J\'s later reclaim re-invoke the session -- a residual double-send risk the excludeJobId guard alone does not bound', async () => {
    const { jobId, conversationKey, deliveryJid, sourceInboundSeq } = crashOneSourceTurn(db, durability, '15550190783', 'j-defers');
    const mapKey = deliveryJid;

    const session = sessionStub();
    const managerId = state.managerIdFor(session);
    state.sessionOwnership.claim(mapKey, managerId);
    state.sessionOwnership.transition(mapKey, managerId, 'active');
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queueStub(deliveryJid));
    state.sessionEventToolScopes.set(session, mapKey);
    const supervisorState = state as unknown as LiveWiringRuntimeState;

    // --- Round 1: J's own replay (T1) itself defers, exactly like (d). ---
    const scan1 = supervisorState.turnRecoverySupervisor.scanOnce();
    await vi.waitFor(() => expect(state.perChatRuntimeTurnCompletions.has(mapKey)).toBe(true));
    state.perChatRuntimeTurnCompletions.get(mapKey)!.resolve();
    // This test drives finalization manually (provider round-trip out of
    // scope, per the file header) rather than through
    // applyRuntimeTurnPostEffects, which normally clears ALL of this FIFO
    // bookkeeping together as part of settling the turn -- replicate the
    // full clear here (not just the completions entry), so round 2 below
    // can register a fresh completion for the same mapKey.
    // beginPerChatRuntimeTurn (runtime.ts:5082-5085) throws "FIFO already
    // has an active owner" if perChatRuntimeTurnContexts still holds this
    // mapKey's entry -- an earlier version of this test only cleared
    // perChatRuntimeTurnCompletions and round 2 threw there instead of
    // ever reaching session.sendTurn, silently passing the assertion below
    // for the wrong reason. Caught by checking the log, not guessed.
    state.perChatRuntimeTurnCompletions.delete(mapKey);
    state.perChatRuntimeTurnContexts.delete(mapKey);
    state.perChatInboundSeqQueue.delete(mapKey);
    const result1 = await scan1;
    expect(result1).toMatchObject({ claimed: 1, requeued: 1 });
    expect(session.sendTurn).toHaveBeenCalledTimes(1);

    // --- Construct J2: a genuinely real, independent recovery job for the
    // SAME source_inbound_seq -- exactly what T1's own transferred_to_recovery_owner
    // finalization would create in production (toTurnRecoveryJobPersistence
    // requires that disposition and carries sourceInboundSeq through
    // unchanged), built directly via finalizeTurnTerminal rather than
    // running a full second runtime-turn pipeline (same
    // out-of-scope-provider-round-trip boundary as the rest of this file). ---
    const t1Identity = {
      scope: 'per_chat' as const, conversationKey, deliveryJid, inboundSeq: sourceInboundSeq,
      logicalTurnId: 'turn-replay-j-defers', managerId: 'manager-replay', generation: 4,
    };
    const t1DeliveryOpId = durability.createOutboundOp({
      conversationKey, chatJid: deliveryJid, opType: 'text',
      payload: JSON.stringify({ text: 'replay attempt itself deferred' }),
      sourceInboundSeq, replayPolicy: 'unsafe',
    });
    const t1Final: TurnTerminalResult = {
      identity: t1Identity,
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId: t1DeliveryOpId },
    };
    const OWNER2: RecoveryOwnerIdentity = { logicalTurnId: 'live-wiring-j2-owner', managerId: 'manager-j2', generation: 1 };
    const j2Envelope: TurnRecoveryReplayEnvelope = {
      sourceMessageId: 'wamid-live-j-defers',
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550100002:9@s.whatsapp.net', senderName: 'Live Wiring Sender',
      text: 'Live wiring replay text', isGroup: false,
    };
    const j2Params = {
      ...toTurnFinalizationPersistence(t1Final, OWNER2),
      recoveryJob: toTurnRecoveryJobPersistence(t1Final, OWNER2, j2Envelope),
    };
    const j2Receipt = durability.finalizeTurnTerminal(j2Params);
    const j2Id = j2Receipt.recoveryJob!.jobId;
    durability.markSending(t1DeliveryOpId);
    db.raw.prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE id = ?`).run(t1DeliveryOpId);

    // J2 genuinely outstanding now -- confirms the fixture built a real,
    // second, independent job row, not a no-op.
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey, { excludeJobId: jobId }))
      .toBe(true);

    // --- J2 genuinely completes (T2 succeeds): claim + close it through the
    // REAL store methods, exactly as production would once T2 proves echo. ---
    const j2Claim = durability.claimTurnRecoveryJob(j2Id, OWNER2, { claimToken: 'j2-claim', leaseSeconds: 120 });
    expect(j2Claim.applied).toBe(true);
    const j2Fence: TurnRecoveryClaimFence = { claimToken: j2Claim.claimToken, claimEpoch: j2Claim.claimEpoch };
    durability.completeInbound(sourceInboundSeq, 'response_echoed');
    const j2Complete = durability.completeTurnRecoveryJob(j2Id, OWNER2, j2Fence);
    expect(j2Complete.applied).toBe(true);

    // J2 no longer outstanding -- the guard that bounded J's retry WHILE J2
    // was outstanding no longer applies to J's next reclaim.
    expect(durability.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey, { excludeJobId: jobId }))
      .toBe(false);

    // --- Round 2: J's backoff expires; next scan reclaims and redispatches it. ---
    db.raw.prepare(`UPDATE turn_recovery_jobs SET next_attempt_at = datetime('now', '-10 seconds') WHERE id = ?`).run(jobId);
    const scan2 = supervisorState.turnRecoverySupervisor.scanOnce();

    // THE QUESTION under test: does reclaiming J re-invoke session.sendTurn
    // -- asking the agent to reprocess/resend content a DIFFERENT job (J2)
    // already genuinely delivered? verifyProvenBeforeDelivered's PRE-check
    // (turn-recovery-dispatch.ts) is supposed to catch exactly this: at
    // reclaim time the shared source is ALREADY proven (J2's completion set
    // processing_status='complete'; J's own original delivery has been
    // 'quarantined' since creation), so dispatchReplay should never even be
    // called -- no fresh completion is registered, session.sendTurn is
    // never invoked, and scan2 should settle quickly on its own.
    await vi.waitFor(() => {
      expect(state.perChatRuntimeTurnCompletions.has(mapKey) || session.sendTurn.mock.calls.length > 1).toBe(true);
    }, { timeout: 500 }).catch(() => {});
    if (state.perChatRuntimeTurnCompletions.has(mapKey)) {
      state.perChatRuntimeTurnCompletions.get(mapKey)!.resolve();
    }
    const result2 = await scan2;

    // OBSERVED (boterr-lead's required proof, run for real -- not predicted):
    // the pre-check catches it. session.sendTurn is called EXACTLY ONCE
    // total -- J's round-2 reclaim never reaches processPerChatTurn at all.
    // The prior (now-fixed) gap: neither existing pre-claim guard catches
    // this case -- getTurnRecoveryOriginalDeliveryStatus checks J's OWN
    // original delivery (already 'quarantined' from creation, unrelated to
    // J2's completion), and excludeJobId's admission check is scoped to
    // "any OTHER outstanding job", not "has this job's own source since
    // been delivered by whatever superseded it". verifyProvenBeforeDelivered's
    // pre-check closes that gap by reusing the SAME store proof
    // completeTurnRecoveryJob demands, checked BEFORE dispatch instead of
    // only after.
    expect(session.sendTurn).toHaveBeenCalledTimes(1);
    expect(result2.claimed).toBe(1);
    expect(result2.completed).toBe(1);

    const job = durability.getTurnRecoveryJob(jobId)!;
    expect(job.state).toBe('completed');
  });
});

describe('AgentRuntime.shutdown — H2 turn-recovery scan quiescence ordering', () => {
  let db: Database;
  let durability: DurabilityEngine;
  let runtime: ReturnType<typeof makeRuntimeState<LiveWiringRuntimeState>>['runtime'];
  let state: LiveWiringRuntimeState;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
    const built = makeRuntimeState<LiveWiringRuntimeState>(db, { sessionScope: 'per_chat' });
    runtime = built.runtime;
    state = built.state;
    runtime.setDurability(durability);
  });

  afterEach(() => {
    db.close();
  });

  it('H2: turnRecoverySupervisor.stop() is called BEFORE any per-chat session is torn down -- a scan cannot fire into a dying/dead session', async () => {
    const mapKey = '15550199000@s.whatsapp.net';
    const session = sessionStub();
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queueStub(mapKey));

    const stopSpy = vi.spyOn(state.turnRecoverySupervisor, 'stop');

    await runtime.shutdown();

    // Pre-fix: TurnRecoverySupervisor.stop() has ZERO callers anywhere in
    // runtime.ts (confirmed by repo-wide grep before writing this fix) --
    // this assertion alone fails RED without the fix, since stop() is never
    // invoked at all. Post-fix: called, AND strictly BEFORE the per-chat
    // session's own teardown -- proving the scan loop is quiesced first,
    // not merely called "at some point during" shutdown (which would still
    // leave the mid-shutdown dispatch race open).
    expect(stopSpy).toHaveBeenCalled();
    expect(session.shutdown).toHaveBeenCalled();
    const stopOrder = stopSpy.mock.invocationCallOrder[0]!;
    const teardownOrder = vi.mocked(session.shutdown).mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(teardownOrder);
  });

  it('starts the independent deadman with per-chat durability and stops it before the watched supervisor', async () => {
    expect(state.turnRecoveryDeadman.health().running).toBe(true);
    const deadmanStop = vi.spyOn(state.turnRecoveryDeadman, 'stop');
    const supervisorStop = vi.spyOn(state.turnRecoverySupervisor, 'stop');

    await runtime.shutdown();

    expect(deadmanStop).toHaveBeenCalledTimes(1);
    expect(supervisorStop).toHaveBeenCalled();
    expect(deadmanStop.mock.invocationCallOrder[0]).toBeLessThan(
      supervisorStop.mock.invocationCallOrder[0]!,
    );
  });
});
