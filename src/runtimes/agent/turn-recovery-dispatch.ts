// PRESTAGE-T4: extracted from runtime.ts (arch.file-size ratchet — runtime.ts
// has zero headroom against .claude/fitness/baseline.json's grandfathered
// ceiling; new per_chat-turn-recovery logic belongs in its own module, not
// inline in the already-at-limit file). Two pieces live here:
//   - createTurnRecoverySupervisorForRuntime: the TurnRecoverySupervisor
//     construction/wiring, factored out of AgentRuntime's constructor.
//   - dispatchTurnRecoveryReplayViaSession: the real TurnRecoveryReplayDispatcher
//     body, factored out of AgentRuntime.dispatchTurnRecoveryReplay. The thin
//     wrapper left in runtime.ts only resolves the mapKey/session (both need
//     private AgentRuntime state) and delegates here.
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../logger.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { TurnRecoveryClaimFence, TurnRecoveryJobRow } from '../../core/turn-recovery-store.ts';
import type {
  PerChatRuntimeScopeRef,
  RuntimeTurnCoordinator,
  RuntimeTurnSourceSnapshot,
} from './runtime-turn-coordinator.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type { SessionManager } from './session.ts';
import type { QueuedTurn } from './turn-queue.ts';
import {
  TurnRecoverySupervisor,
  type TurnRecoveryReplayDispatchResult,
} from './turn-recovery-supervisor.ts';

const log = createChildLogger('turn-recovery-dispatch');

export function createTurnRecoverySupervisorForRuntime(deps: {
  readonly instanceName: string;
  readonly getDurability: () => DurabilityEngine | null;
  readonly dispatchReplay: (
    job: TurnRecoveryJobRow,
    fence: TurnRecoveryClaimFence,
  ) => Promise<TurnRecoveryReplayDispatchResult>;
  readonly recoveryManagerId: string;
  readonly nextRecoveryGeneration: () => number;
  readonly hasSessionForChat: (deliveryJid: string) => boolean;
}): TurnRecoverySupervisor {
  // per_chat only for now — shared/singleton recovery jobs are left exactly
  // as wedged as they are today (skippedUnsupportedScope, not a regression);
  // their session-lifecycle machinery differs materially and is separate
  // follow-up wiring.
  return new TurnRecoverySupervisor({
    instanceName: deps.instanceName,
    durability: deps.getDurability,
    dispatchReplay: verifyProvenBeforeDelivered(deps.dispatchReplay, deps.getDurability),
    freshOwnerIdentity: () => ({
      logicalTurnId: `${randomUUID()}:turn-recovery-supervisor`,
      managerId: deps.recoveryManagerId,
      generation: deps.nextRecoveryGeneration(),
    }),
    supportedScopes: new Set(['per_chat']),
    isDispatchable: (job) => job.scope === 'per_chat' && deps.hasSessionForChat(job.delivery_jid),
  });
}

/**
 * The exact proof `completeTurnRecoveryJob` re-verifies before it will close
 * a job -- source inbound `processing_status` + original delivery's outbound
 * status -- both true. Shared by the pre- and post- dispatch checks below;
 * `undefined` (job gone, or a claim that raced expiry) is never proof of
 * anything and fails closed to false.
 */
function isSourceProven(job: TurnRecoveryJobRow, getDurability: () => DurabilityEngine | null): boolean {
  const proof = getDurability()?.getTurnRecoverySourceProof(job.id);
  return proof !== undefined
    && ['complete', 'failed'].includes(proof.processingStatus)
    && ['echoed', 'failed_permanent', 'quarantined'].includes(proof.outboundStatus);
}

/**
 * Wraps `dispatchReplay` with the store's OWN completion proof on BOTH sides
 * of the call -- boterr-lead ruling: reuse the SAME proof-gate read for
 * both, rather than two different mechanisms.
 *
 * PRE-check (skip-if-already-proven): a job's source can become proven
 * WITHOUT this job's own dispatch ever running -- e.g. its earlier replay
 * itself deferred to a NEW recovery job (see POST-check below), that
 * successor job later completes for real, and THIS job is then reclaimed
 * after backoff. At that point excludeJobId's admission check no longer
 * blocks it (the successor is no longer outstanding) -- dispatching again
 * would re-invoke the session for content that already went out. If the
 * proof already holds at dispatch time, skip dispatchReplay entirely (never
 * call processPerChatTurn / session.sendTurn) and report 'delivered'
 * directly; the supervisor's own completeTurnRecoveryJob call closes the
 * job cleanly since the SAME proof it demands is already satisfied.
 *
 * POST-check (reclassify-if-unproven): a replay whose OWN finalization is
 * itself `transferred_to_recovery_owner` (deferred to a NEW recovery job
 * rather than proving delivery -- `toInboundMutation` skips the inbound
 * write for that disposition, turn-terminal.ts) still resolves the runtime
 * turn's completion promise (`applyRuntimeTurnPostEffects` fires for any
 * `result.kind === 'terminal'`, regardless of disposition), so the
 * dispatcher reports 'delivered' with no real proof. Passing that straight
 * through would make `completeTurnRecoveryJob` throw on the non-terminal
 * source inbound; the claim then sits with no further lease renewal,
 * expires, and the next scan reclaims and RE-dispatches the SAME job
 * through the ordinary pending-claim path -- a real second send. Checking
 * here instead routes that case through the existing, bounded, visible
 * `retryable_failure` -> `requeueTurnRecoveryJob` -> backoff/exhaustion
 * path. This job's own `excludeJobId` admission check then naturally
 * blocks its retry from racing whichever job now owns the deferred inbound
 * -- until that job completes, at which point the PRE-check above takes
 * over instead of a third dispatch attempt.
 */
function verifyProvenBeforeDelivered(
  dispatchReplay: (
    job: TurnRecoveryJobRow,
    fence: TurnRecoveryClaimFence,
  ) => Promise<TurnRecoveryReplayDispatchResult>,
  getDurability: () => DurabilityEngine | null,
): (job: TurnRecoveryJobRow, fence: TurnRecoveryClaimFence) => Promise<TurnRecoveryReplayDispatchResult> {
  return async (job, fence) => {
    if (isSourceProven(job, getDurability)) return { kind: 'delivered' };
    const outcome = await dispatchReplay(job, fence);
    if (outcome.kind !== 'delivered') return outcome;
    return isSourceProven(job, getDurability) ? outcome : { kind: 'retryable_failure' };
  };
}

/**
 * Real `TurnRecoveryReplayDispatcher` (PRESTAGE-T4): reuses the exact
 * per_chat live-turn pipeline (createRuntimeTurnForDispatch ->
 * processPerChatTurn -> sendTurnPerChat -> beginRuntimeTurnEvidence with
 * excludeJobId -> createRuntimeTurnCompletion -> session.sendTurn -> await
 * completion.promise), not a second, parallel dispatch path. `delivered`
 * does NOT itself mark the job complete: completeTurnRecoveryJob (called by
 * the supervisor next) independently re-validates echo/finalization proof,
 * so an imperfect classification here cannot falsely complete a job.
 * `blocked_unsafe_detected` is not produced yet; every failure here is
 * `retryable_failure` (bounded by the existing exhaustion ceiling).
 */
export async function dispatchTurnRecoveryReplayForJob(
  coordinator: RuntimeTurnCoordinator,
  resolvePerChatMapKey: (deliveryJid: string) => string,
  getSession: (mapKey: string) => SessionManager | undefined,
  requireSessionToolScopeKey: (session: SessionManager) => string,
  job: TurnRecoveryJobRow,
): Promise<TurnRecoveryReplayDispatchResult> {
  // supportedScopes/isDispatchable already filter these before claiming;
  // re-checked here so this can never silently "deliver" otherwise.
  if (job.scope !== 'per_chat') return { kind: 'retryable_failure' };
  const mapKey = resolvePerChatMapKey(job.delivery_jid);
  const session = getSession(mapKey);
  if (!session) return { kind: 'retryable_failure' };

  const source: RuntimeTurnSourceSnapshot = {
    sourceMessageId: job.source_message_id,
    conversationKey: job.conversation_key,
    senderJid: job.sender_jid,
    senderName: job.sender_name,
    contentType: 'text',
    isGroup: job.is_group === 1,
    ...(job.is_group === 1 ? { groupName: job.group_name ?? job.delivery_jid } : {}),
  };

  let runtimeContext: RuntimeTurnContext | null;
  try {
    runtimeContext = coordinator.createRuntimeTurnForDispatch({
      scope: 'per_chat',
      chatJid: job.delivery_jid,
      text: job.replay_text,
      inboundSeq: job.source_inbound_seq,
      source,
      session,
      toolScopeKey: requireSessionToolScopeKey(session),
      mapKey,
    });
  } catch (err) {
    log.warn({ err, jobId: job.id }, 'turn recovery replay context construction failed');
    return { kind: 'retryable_failure' };
  }
  if (!runtimeContext) return { kind: 'retryable_failure' };

  const turn: QueuedTurn = {
    sourceMessageId: source.sourceMessageId,
    conversationKey: source.conversationKey,
    chatJid: job.delivery_jid,
    senderJid: source.senderJid,
    senderName: source.senderName,
    text: job.replay_text,
    isGroup: source.isGroup,
    groupName: source.groupName,
    contentType: 'text',
    runtimeContext,
    inboundSeq: job.source_inbound_seq,
  };
  const scopeRef: PerChatRuntimeScopeRef = { value: mapKey };
  try {
    await coordinator.processPerChatTurn(scopeRef, turn, job.id);
  } catch (err) {
    log.warn({ err, jobId: job.id }, 'turn recovery replay dispatch failed');
    return { kind: 'retryable_failure' };
  }
  return { kind: 'delivered' };
}

/** Shutdown wrapper so runtime.ts's shutdown() stays a 2-line call site. */
export async function shutdownTurnRecoverySupervisorSafely(
  supervisor: TurnRecoverySupervisor,
): Promise<unknown> {
  try {
    await supervisor.shutdown();
    return null;
  } catch (err) {
    log.error({ err }, 'turn recovery supervisor scan in flight remained unresolved during shutdown');
    return err;
  }
}

export interface TurnRecoveryHealthDetails {
  readonly turnRecoveryOutstanding: number;
  readonly turnRecoveryPending: number;
  readonly turnRecoveryLiveClaimed: number;
  readonly turnRecoveryExpiredClaimed: number;
  readonly turnRecoveryBlockedUnsafe: number;
  readonly turnRecoveryExhausted: number;
  readonly turnRecoveryOpenRecoveries: number;
  readonly turnRecoveryQuarantinedDelivery: number;
  readonly turnRecoveryCorruptLinks: number;
  readonly turnRecoveryOrphanTransfers: number;
  readonly turnRecoveryEchoConflicts: number;
}

/** Pure projection of durability's supervisor counts (arch.file-size extraction). */
export function getTurnRecoveryHealthDetails(
  durability: DurabilityEngine | null,
): TurnRecoveryHealthDetails {
  const counts = typeof durability?.getTurnRecoverySupervisorCounts === 'function'
    ? durability.getTurnRecoverySupervisorCounts()
    : {
      outstanding: 0, pending: 0, liveClaimed: 0, expiredClaimed: 0,
      blockedUnsafe: 0, exhausted: 0, quarantinedDelivery: 0, corruptLinks: 0,
      orphanTransfers: 0, echoConflicts: 0, openRecoveries: 0,
    };
  return {
    turnRecoveryOutstanding: counts.outstanding,
    turnRecoveryPending: counts.pending,
    turnRecoveryLiveClaimed: counts.liveClaimed,
    turnRecoveryExpiredClaimed: counts.expiredClaimed,
    turnRecoveryBlockedUnsafe: counts.blockedUnsafe,
    turnRecoveryExhausted: counts.exhausted,
    turnRecoveryOpenRecoveries: counts.openRecoveries,
    turnRecoveryQuarantinedDelivery: counts.quarantinedDelivery,
    turnRecoveryCorruptLinks: counts.corruptLinks,
    turnRecoveryOrphanTransfers: counts.orphanTransfers ?? 0,
    turnRecoveryEchoConflicts: counts.echoConflicts ?? 0,
  };
}
