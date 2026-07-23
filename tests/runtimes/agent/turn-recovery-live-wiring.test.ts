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
import type { TurnRecoveryReplayDispatchResult } from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';
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
      skippedUnsupportedScope: number;
      skippedNotDispatchable: number;
    }>;
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
});
