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
  type TurnRecoveryDispatchTarget,
  type TurnRecoveryReplayAbortControl,
  type TurnRecoveryReplayDispatchResult,
} from './turn-recovery-supervisor.ts';

const log = createChildLogger('turn-recovery-dispatch');

export function createTurnRecoverySupervisorForRuntime(deps: {
  readonly instanceName: string;
  readonly getDurability: () => DurabilityEngine | null;
  readonly dispatchReplay: (
    job: TurnRecoveryJobRow,
    fence: TurnRecoveryClaimFence,
    target?: TurnRecoveryDispatchTarget,
    abortControl?: TurnRecoveryReplayAbortControl,
  ) => Promise<TurnRecoveryReplayDispatchResult>;
  readonly recoveryManagerId: string;
  readonly nextRecoveryGeneration: () => number;
  readonly resolveDispatchTarget: (job: TurnRecoveryJobRow) => TurnRecoveryDispatchTarget | null;
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
    resolveDispatchTarget: deps.resolveDispatchTarget,
  });
}

/**
 * Wraps `dispatchReplay` so a 'delivered' outcome is only reported once the
 * store's OWN completion proof -- source inbound `processing_status` +
 * original delivery's outbound status, the exact pair `completeTurnRecoveryJob`
 * re-verifies before it will close a job -- is actually satisfied.
 *
 * Without this: a replay whose OWN finalization is itself
 * `transferred_to_recovery_owner` (the replay deferred to a NEW recovery job
 * rather than proving delivery -- `toInboundMutation` skips the inbound
 * write for that disposition, turn-terminal.ts) still resolves the runtime
 * turn's completion promise (`applyRuntimeTurnPostEffects` fires for any
 * `result.kind === 'terminal'`, regardless of disposition), so the dispatcher
 * reports 'delivered' with no real proof. `completeTurnRecoveryJob` then
 * throws on the non-terminal source inbound; the claim sits with no further
 * lease renewal, expires, and the next scan reclaims and RE-dispatches the
 * SAME job through the ordinary pending-claim path -- a real second send.
 *
 * Checking here instead routes that case through the existing, bounded,
 * visible `retryable_failure` -> `requeueTurnRecoveryJob` -> backoff/
 * exhaustion path. This job's own `excludeJobId` admission check then
 * naturally blocks its retry from racing whichever job now owns the
 * deferred inbound, until that job completes -- at which point
 * `claimAndReplay`'s own already-delivered-source PRE-dispatch guard
 * (turn-recovery-supervisor.ts, same proof read, boterr-lead ruling) takes
 * over and closes this job directly, without a third dispatch attempt.
 */
function verifyProvenBeforeDelivered(
  dispatchReplay: (
    job: TurnRecoveryJobRow,
    fence: TurnRecoveryClaimFence,
    target?: TurnRecoveryDispatchTarget,
    abortControl?: TurnRecoveryReplayAbortControl,
  ) => Promise<TurnRecoveryReplayDispatchResult>,
  getDurability: () => DurabilityEngine | null,
): (
  job: TurnRecoveryJobRow,
  fence: TurnRecoveryClaimFence,
  target?: TurnRecoveryDispatchTarget,
  abortControl?: TurnRecoveryReplayAbortControl,
) => Promise<TurnRecoveryReplayDispatchResult> {
  return async (job, fence, target, abortControl) => {
    const outcome = await dispatchReplay(job, fence, target, abortControl);
    if (outcome.kind !== 'delivered') return outcome;
    // Fail closed: an undefined row (job gone, or claim raced expiry in the
    // narrow window between dispatch resolving and this check) is not proof
    // of anything -- treat exactly like an unproven outcome.
    const proof = getDurability()?.getTurnRecoverySourceProof(job.id);
    const proven = proof !== undefined
      && ['complete', 'failed'].includes(proof.processingStatus)
      && ['echoed', 'failed_permanent', 'quarantined'].includes(proof.outboundStatus);
    return proven ? outcome : { kind: 'retryable_failure' };
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
  isTargetCurrent: (target: TurnRecoveryDispatchTarget) => boolean,
  abortTarget: (
    target: TurnRecoveryDispatchTarget,
    context: RuntimeTurnContext,
  ) => Promise<boolean>,
  job: TurnRecoveryJobRow,
  target?: TurnRecoveryDispatchTarget,
  abortControl?: TurnRecoveryReplayAbortControl,
): Promise<TurnRecoveryReplayDispatchResult> {
  // supportedScopes/isDispatchable already filter these before claiming;
  // re-checked here so this can never silently "deliver" otherwise.
  if (job.scope !== 'per_chat') return { kind: 'retryable_failure' };
  const mapKey = resolvePerChatMapKey(job.delivery_jid);
  if (target?.mapKey !== mapKey) return { kind: 'retryable_failure' };
  const session = target?.session as SessionManager | undefined;
  if (session !== getSession(mapKey)) return { kind: 'retryable_failure' };
  if (!session || !target || !isTargetCurrent(target)) return { kind: 'retryable_failure' };

  const source: RuntimeTurnSourceSnapshot = {
    sourceMessageId: job.source_message_id,
    receivedAtUnixSeconds: job.source_received_at_unix_seconds,
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
  let providerBoundaryCrossed = false;
  abortControl?.registerAbort(async () => (
    providerBoundaryCrossed
      ? abortTarget(target, runtimeContext)
      : true
  ));

  const turn: QueuedTurn = {
    sourceMessageId: source.sourceMessageId,
    receivedAtUnixSeconds: source.receivedAtUnixSeconds,
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
    await coordinator.processPerChatTurn(
      scopeRef,
      turn,
      job.id,
      () => isTargetCurrent(target) && abortControl?.signal.aborted !== true,
      () => { providerBoundaryCrossed = true; },
    );
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
