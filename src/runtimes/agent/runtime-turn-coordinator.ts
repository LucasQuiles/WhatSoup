import { randomUUID } from 'node:crypto';
import type { ContentType } from '../../core/types.ts';
import type {
  DurabilityEngine,
  TurnFinalizationBookkeepingParams,
} from '../../core/durability.ts';
import { splitInputTokenUsage, type AgentEvent } from './stream-parser.ts';
import { classifyProviderFailure } from './failure-taxonomy.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import { TurnQueue, type QueuedTurn, type TurnRejectReason } from './turn-queue.ts';
import type { SessionManager } from './session.ts';
import { config } from '../../config.ts';
import { collectRuntimeTurnAnswerEvidence } from './runtime-turn-finalization.ts';
import {
  createRuntimeTurnContext,
  markRuntimeTurnReplayUnsafe as makeRuntimeTurnReplayUnsafe,
  rebindRuntimeTurnOwner,
  type RuntimeTurnContext,
} from './runtime-turn-context.ts';
import type { AttemptOutcome } from './turn-terminal.ts';
import {
  finalizeRuntimeTurn,
  type FinalizeRuntimeTurnResult,
  type RuntimeAnswerEvidence,
} from './turn-finalizer.ts';
import type {
  RetainedRuntimeTurnFinalization,
  RuntimeTurnRetryResult,
  RuntimeTurnSupervisor,
} from './runtime-turn-supervisor.ts';
import type { SystemTurnLeaseToken } from './pending-system-result-tracker.ts';
import type { ReplyGuaranteeManager } from '../../core/reply-guarantee.ts';
import type { SessionOwnershipRegistry } from './session-ownership.ts';
import { createChildLogger } from '../../logger.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';

const log = createChildLogger('agent-runtime');
export const RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS = 2_000;

export interface RuntimeTurnSourceSnapshot {
  readonly sourceMessageId: string;
  readonly conversationKey: string;
  readonly senderJid: string;
  readonly senderName: string | null;
  readonly contentType: ContentType;
  readonly isGroup: boolean;
  readonly groupName?: string;
}

export interface RuntimeTurnCompletion {
  readonly context: RuntimeTurnContext;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface PerChatRuntimeScopeRef {
  value: string;
}

export interface RuntimeTurnPostEffects {
  readonly queue: IOutboundQueue | null;
  readonly scopeRef?: PerChatRuntimeScopeRef;
  readonly clearReplayOnSuccess?: boolean;
  readonly admissionRejected?: boolean;
  readonly voice?: { chatJid: string; responseText: string; inboundContentType: string | null };
  readonly ledger: {
    fifoValidated: boolean;
    guaranteeDisarmed: boolean;
    queueCleared: boolean;
    fifoAdvanced: boolean;
    presentationCleared: boolean;
    replayCleared: boolean;
    completionSettled: boolean;
    voiceScheduled: boolean;
    afterTerminalActionRun: boolean;
  };
}

export type RuntimeTurnAfterTerminalAction = (
  result: Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }>,
) => void | Promise<void>;

export interface RuntimeTurnCoordinatorPort {
  readonly durability: DurabilityEngine | null;
  readonly instanceName: string;
  readonly runtimeTurnSupervisor: RuntimeTurnSupervisor<RuntimeTurnPostEffects>;
  readonly sessionOwnership: SessionOwnershipRegistry;
  readonly recoveryManagerId: string;
  recoveryGeneration: number;
  readonly replyGuarantee: ReplyGuaranteeManager | null;
  readonly perChatInboundSeqQueue: Map<string, number[]>;
  readonly perChatRuntimeTurnContexts: Map<string, RuntimeTurnContext[]>;
  readonly perChatRuntimeTurnCompletions: Map<string, RuntimeTurnCompletion>;
  readonly perChatRuntimeTurnScopeRefs: Map<string, PerChatRuntimeScopeRef>;
  readonly turnQueue: TurnQueue;
  readonly perChatTurnQueues: Map<string, TurnQueue>;
  readonly perChatTurnQueueKeys: WeakMap<TurnQueue, PerChatRuntimeScopeRef>;
  readonly perChatExecActorQueue: Map<string, (string | undefined)[]>;
  readonly pendingTurnText: Map<string, string>;
  readonly pendingTurnActorJid: Map<string, string | undefined>;
  readonly perChatTurnSourceMessageId: Map<string, string>;
  readonly perChatTurnContentType: Map<string, string>;
  readonly perChatTurnText: Map<string, string>;
  readonly perChatTurnSuppressedReplySatisfaction: Set<string>;
  readonly perChatAssistantItemText: Map<string, Map<string, string>>;
  readonly perChatRouteMarkerHold: Map<string, string>;
  readonly chatQueues: Map<string, IOutboundQueue>;
  readonly chatSessions: Map<string, SessionManager>;
  session: SessionManager | null;
  pendingSingletonRuntimeTurnContext?: RuntimeTurnContext | null;
  currentInboundSeq: number | undefined;
  currentRuntimeTurnContext: RuntimeTurnContext | null;
  currentRuntimeTurnCompletion: RuntimeTurnCompletion | null;
  currentTurnChatJid: string | null;
  currentTurnReplayText: string | null;
  currentTurnReplayActorJid: string | undefined;
  currentTurnInboundContentType: string | null;
  currentTurnAssistantText: string;
  readonly currentTurnAssistantItemText: Map<string, string>;
  turnHadVisibleOutput: boolean;
  turnHadSuppressedReplySatisfaction: boolean;
  readonly runtimeTurnAfterTerminal: Map<string, RuntimeTurnAfterTerminalAction>;
  managerIdFor(session: SessionManager): string;
  isShuttingDown?(): boolean;
  getActiveQueue(): IOutboundQueue | null;
  getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null;
  sendTurnPerChat(
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    runtimeContext?: RuntimeTurnContext,
    scopeRef?: PerChatRuntimeScopeRef,
    systemTurnLease?: SystemTurnLeaseToken,
    excludeJobId?: number,
  ): Promise<void>;
  sendVoiceReply(chatJid: string, responseText: string): Promise<void>;
}

export class RuntimeTurnCoordinator {
  private readonly host: RuntimeTurnCoordinatorPort;
  private readonly activeFinalizations = new Map<string, Promise<FinalizeRuntimeTurnResult>>();
  private readonly cancelledUndispatchedTurnIds = new Set<string>();
  private readonly undispatchedCrashFinalizations = new Map<string, Promise<void>>();
  private readonly rejectedTurnFinalizations = new Set<Promise<void>>();
  private readonly rejectedTurnFinalizationFailures: unknown[] = [];
  private readonly continuationDeferrals = new Map<string, {
    initialResultConsumed: boolean;
    cancelled: boolean;
    readonly consumed: Promise<void>;
    readonly resolveConsumed: () => void;
  }>();

  constructor(host: RuntimeTurnCoordinatorPort) {
    this.host = host;
  }

runtimeTurnContext(mapKey?: string): RuntimeTurnContext | null {
  return mapKey === undefined
    ? this.host.currentRuntimeTurnContext
    : this.host.perChatRuntimeTurnContexts.get(mapKey)?.[0] ?? null;
}

markRuntimeTurnReplayUnsafe(mapKey?: string): void {
  if (mapKey === undefined) {
    if (this.host.currentRuntimeTurnContext) {
      this.host.currentRuntimeTurnContext = makeRuntimeTurnReplayUnsafe(
        this.host.currentRuntimeTurnContext,
      );
    }
    return;
  }
  const contexts = this.host.perChatRuntimeTurnContexts.get(mapKey);
  if (contexts?.[0]) contexts[0] = makeRuntimeTurnReplayUnsafe(contexts[0]);
}

rebindRuntimeTurnForDispatch(
  context: RuntimeTurnContext,
  session: SessionManager,
  mapKey?: string,
): RuntimeTurnContext {
  const managerId = this.host.managerIdFor(session);
  if (mapKey === undefined) {
    return rebindRuntimeTurnOwner(context, { managerId, generation: 1 });
  }
  const owner = this.host.sessionOwnership.get(mapKey);
  if (!owner || owner.managerId !== managerId) {
    throw new Error(`Per-chat runtime turn has no current dispatch owner for "${mapKey}"`);
  }
  return rebindRuntimeTurnOwner(context, {
    managerId: owner.managerId,
    generation: owner.generation,
  });
}

appendRuntimeTurnAfterTerminalAction(
  context: RuntimeTurnContext,
  action: RuntimeTurnAfterTerminalAction,
): void {
  const turnId = context.identity.logicalTurnId;
  const prior = this.host.runtimeTurnAfterTerminal.get(turnId);
  this.host.runtimeTurnAfterTerminal.set(turnId, async (result) => {
    await prior?.(result);
    await action(result);
  });
}

beginRuntimeTurnContinuation(context: RuntimeTurnContext): boolean {
  const turnId = context.identity.logicalTurnId;
  if (this.continuationDeferrals.has(turnId)) return false;
  let resolveConsumed!: () => void;
  const consumed = new Promise<void>((resolve) => { resolveConsumed = resolve; });
  this.continuationDeferrals.set(turnId, {
    initialResultConsumed: false,
    cancelled: false,
    consumed,
    resolveConsumed,
  });
  return true;
}

consumeRuntimeTurnContinuationDeferral(context: RuntimeTurnContext): boolean {
  const turnId = context.identity.logicalTurnId;
  const deferral = this.continuationDeferrals.get(turnId);
  if (!deferral) return false;
  if (deferral.cancelled) {
    this.continuationDeferrals.delete(turnId);
    return false;
  }
  if (!deferral.initialResultConsumed) {
    deferral.initialResultConsumed = true;
    deferral.resolveConsumed();
    return true;
  }
  this.continuationDeferrals.delete(turnId);
  return false;
}

async claimFailedRuntimeTurnContinuation(context: RuntimeTurnContext): Promise<boolean> {
  const turnId = context.identity.logicalTurnId;
  const deferral = this.continuationDeferrals.get(turnId);
  if (!deferral) return false;
  await deferral.consumed;
  if (this.continuationDeferrals.get(turnId) !== deferral || deferral.cancelled) return false;
  this.continuationDeferrals.delete(turnId);
  return true;
}

cancelRuntimeTurnContinuation(context: RuntimeTurnContext): boolean {
  const deferral = this.continuationDeferrals.get(context.identity.logicalTurnId);
  if (!deferral) return false;
  deferral.cancelled = true;
  deferral.resolveConsumed();
  return true;
}

finishRuntimeTurnContinuation(context: RuntimeTurnContext): void {
  const deferral = this.continuationDeferrals.get(context.identity.logicalTurnId);
  deferral?.resolveConsumed();
  this.continuationDeferrals.delete(context.identity.logicalTurnId);
}

markRuntimeTurnDegraded(context: RuntimeTurnContext): void {
  this.host.runtimeTurnSupervisor.markDegraded(context);
}

rejectRuntimeTurnCompletion(
  error: unknown,
  mapKey?: string,
  expectedContext?: RuntimeTurnContext,
): boolean {
  const completion = mapKey === undefined
    ? this.host.currentRuntimeTurnCompletion
    : this.host.perChatRuntimeTurnCompletions.get(mapKey);
  if (!completion) return false;
  if (
    expectedContext
    && completion.context.identity.logicalTurnId !== expectedContext.identity.logicalTurnId
  ) return false;
  completion.reject(error);
  return true;
}

runtimeTurnScopeKey(context: RuntimeTurnContext): string {
  return this.host.runtimeTurnSupervisor.scopeKey(context);
}

createRuntimeTurnCompletion(context: RuntimeTurnContext): RuntimeTurnCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { context, promise, resolve, reject };
}

createRuntimeTurnPostEffects(
  effects: Omit<RuntimeTurnPostEffects, 'ledger'>,
): RuntimeTurnPostEffects {
  return {
    ...effects,
    ledger: {
      fifoValidated: false,
      guaranteeDisarmed: false,
      queueCleared: false,
      fifoAdvanced: false,
      presentationCleared: false,
      replayCleared: false,
      completionSettled: false,
      voiceScheduled: false,
      afterTerminalActionRun: false,
    },
  };
}

createRuntimeTurnForDispatch(args: {
  scope: RuntimeTurnContext['identity']['scope'];
  chatJid: string;
  text: string;
  inboundSeq: number | undefined;
  source: RuntimeTurnSourceSnapshot;
  session: SessionManager;
  toolScopeKey: string;
  mapKey?: string;
}): RuntimeTurnContext | null {
  if (args.inboundSeq === undefined) return null;
  if (!this.host.durability) {
    throw new Error('Journaled agent turns require durability before dispatch');
  }

  const ownership = args.mapKey === undefined
    ? { managerId: this.host.managerIdFor(args.session), generation: 1 }
    : this.host.sessionOwnership.get(args.mapKey);
  if (!ownership) {
    throw new Error(`Journaled per-chat turn has no owned session for "${args.mapKey}"`);
  }

  const logicalTurnId = randomUUID();
  const context = createRuntimeTurnContext({
    identity: {
      scope: args.scope,
      conversationKey: args.source.conversationKey,
      deliveryJid: args.chatJid,
      inboundSeq: args.inboundSeq,
      logicalTurnId,
      managerId: ownership.managerId,
      generation: ownership.generation,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: this.host.recoveryManagerId,
      generation: ++this.host.recoveryGeneration,
    },
    replay: {
      sourceMessageId: args.source.sourceMessageId,
      replaySafe: true,
      senderJid: args.source.senderJid,
      senderName: args.source.senderName,
      text: args.text,
      isGroup: args.source.isGroup,
      ...(args.source.isGroup ? { groupName: args.source.groupName ?? args.chatJid } : {}),
    },
    contentType: args.source.contentType,
    toolScopeKey: args.toolScopeKey,
  });
  return context;
}

/**
 * `excludeJobId` is set only by the turn-recovery supervisor's own replay
 * dispatch (PRESTAGE-T4): that replay's admission check must not find its
 * OWN still-`claimed` job and self-block — the job cannot reach a terminal
 * state until this very replay completes, so without the exclusion every
 * supervisor-driven replay would deadlock against itself on its first
 * admission check. Every other caller (normal live turns) omits it, so
 * their admission predicate is unchanged.
 */
beginRuntimeTurnEvidence(
  queue: IOutboundQueue,
  context: RuntimeTurnContext,
  excludeJobId?: number,
): void {
  const durability = this.host.durability;
  if (
    typeof durability?.hasOutstandingTurnRecoveryForScope === 'function'
    && durability.hasOutstandingTurnRecoveryForScope(
      context.identity.scope,
      context.identity.conversationKey,
      excludeJobId !== undefined ? { excludeJobId } : undefined,
    )
  ) {
    throw new Error('Runtime turn scope is blocked by outstanding durable recovery');
  }
  if (!this.host.runtimeTurnSupervisor.canAccept(context)) {
    throw new Error('Runtime turn scope is blocked by terminal-finalization recovery state');
  }
  queue.beginTurnEvidence(context.identity.logicalTurnId);
}

attemptOutcomeForResult(
  event: Extract<AgentEvent, { type: 'result' }>,
): AttemptOutcome {
  const providerFailure = event.text ? classifyProviderFailure(event.text) : null;
  if (providerFailure === 'policy-block') return { kind: 'suppressed_by_policy' };
  if (providerFailure !== null) return { kind: 'failed', class: providerFailure };
  if (event.isError === true) return { kind: 'failed', class: 'unknown_terminal' };
  return { kind: 'completed' };
}

turnFinalizationBookkeeping(
  context: RuntimeTurnContext,
  session: SessionManager | null,
  event?: Extract<AgentEvent, { type: 'result' }>,
  attemptOutcome?: AttemptOutcome,
): TurnFinalizationBookkeepingParams {
  const rowId = session?.getDbRowId() ?? null;
  const status = session?.getStatus();
  const hasUsage = event !== undefined
    && (event.inputTokens !== undefined || event.outputTokens !== undefined);
  if (attemptOutcome?.kind === 'admission_rejected' && context.identity.inboundSeq !== null) {
    const reason = attemptOutcome.class ?? 'unknown';
    log.warn(
      { inboundSeq: context.identity.inboundSeq, scope: context.identity.scope, reason },
      'journaled agent turn rejected before dispatch — automatic replay unavailable',
    );
    emitAlertChecked(
      this.host.instanceName,
      'agent_turn_admission_rejected',
      'Journaled agent turn rejected before dispatch',
      `inbound_seq=${context.identity.inboundSeq} reason=${reason} automatic_replay=false scope=${context.identity.scope}`,
      'warning',
    );
  }
  // #1775: a turn only reaches here without recorded usage in two cases —
  // it was never dispatched (admission_rejected: message_count never
  // incremented, zero really means zero, stay silent) or it WAS dispatched
  // and finalizes via a no-event path (crash / processor_throw / a provider
  // that never reports usage on its result). The latter is indistinguishable
  // from a genuinely-zero-token turn unless it is flagged — otherwise a
  // served message silently persists total_tokens=0 forever. Alert instead
  // of only logging so the loss is never silently dropped.
  if (!hasUsage && rowId !== null && attemptOutcome !== undefined && attemptOutcome.kind !== 'admission_rejected') {
    const scopeKey = this.runtimeTurnScopeKey(context);
    log.warn(
      { rowId, scopeKey, attemptOutcome: attemptOutcome.kind, hadEvent: event !== undefined },
      'turn finalized without recorded token usage — provider usage for this turn is unrecoverable',
    );
    emitAlertChecked(
      this.host.instanceName,
      'agent_turn_usage_unavailable',
      'Turn finalized without recorded token usage',
      `rowId=${rowId} scope=${scopeKey} attemptOutcome=${attemptOutcome.kind} hadEvent=${event !== undefined}`,
      'warning',
    );
  }
  return {
    ...(
      hasUsage && rowId !== null
        ? {
            sessionTokens: (() => {
              // #1774: inputTokens here is new-only (cache_read split out) —
              // the DB accumulator must not sum the same re-read context
              // every turn. See splitInputTokenUsage in stream-parser.ts.
              const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event ?? {});
              return {
                dbRowId: rowId,
                inputTokens: newInputTokens,
                outputTokens: event?.outputTokens ?? 0,
                cacheReadTokens,
              };
            })(),
          }
        : {}
    ),
    checkpoint: {
      // The completing turn owns checkpoint attribution. activeChatJid may
      // still name the first chat that spawned a shared session.
      conversationKey: context.identity.conversationKey,
      fields: {
        ...(status?.sessionId ? { sessionId: status.sessionId } : {}),
        ...(status?.pid ? { claudePid: status.pid } : {}),
        ...(status?.active === undefined || status.durableFailureClosed === true
          ? {}
          : { sessionStatus: status.active ? 'active' : 'suspended' }),
        activeTurnId: null,
        ...(context.identity.inboundSeq === null
          ? {}
          : { lastInboundSeq: context.identity.inboundSeq }),
      },
    },
  };
}

finalizeRuntimeTurnContext(args: {
  context: RuntimeTurnContext;
  queue: IOutboundQueue;
  attemptOutcome: AttemptOutcome;
  session: SessionManager | null;
  event?: Extract<AgentEvent, { type: 'result' }>;
  mapKey?: string;
  clearReplayOnSuccess?: boolean;
  voice?: { chatJid: string; responseText: string; inboundContentType: string | null };
}): Promise<FinalizeRuntimeTurnResult> {
  const turnId = args.context.identity.logicalTurnId;
  const existing = this.activeFinalizations.get(turnId);
  if (existing) return existing;
  const finalization = this.performRuntimeTurnFinalization(args);
  this.activeFinalizations.set(turnId, finalization);
  const release = (): void => {
    if (this.activeFinalizations.get(turnId) === finalization) {
      this.activeFinalizations.delete(turnId);
    }
  };
  void finalization.then(release, release);
  return finalization;
}

private async performRuntimeTurnFinalization(args: {
  context: RuntimeTurnContext;
  queue: IOutboundQueue;
  attemptOutcome: AttemptOutcome;
  session: SessionManager | null;
  event?: Extract<AgentEvent, { type: 'result' }>;
  mapKey?: string;
  clearReplayOnSuccess?: boolean;
  voice?: { chatJid: string; responseText: string; inboundContentType: string | null };
}): Promise<FinalizeRuntimeTurnResult> {
  if (!this.host.durability) {
    throw new Error('Runtime turn finalization requires durability');
  }
  const bookkeeping = this.turnFinalizationBookkeeping(args.context, args.session, args.event, args.attemptOutcome);
  const answerEvidence = await collectRuntimeTurnAnswerEvidence(
    args.queue,
    args.context.identity.logicalTurnId,
  );
  const scopeRef = args.mapKey === undefined
    ? undefined
    : this.host.perChatRuntimeTurnScopeRefs.get(args.context.identity.logicalTurnId)
      ?? { value: args.mapKey };
  const postEffects = this.createRuntimeTurnPostEffects({
    queue: args.queue,
    ...(scopeRef === undefined ? {} : { scopeRef }),
    ...(args.clearReplayOnSuccess === undefined
      ? {}
      : { clearReplayOnSuccess: args.clearReplayOnSuccess }),
    ...(args.voice === undefined ? {} : { voice: args.voice }),
  });
  const result = finalizeRuntimeTurn({
    instanceName: this.host.instanceName,
    durability: this.host.durability,
    identity: args.context.identity,
    attemptOutcome: args.attemptOutcome,
    answerEvidence,
    recoveryOwner: args.context.recoveryOwner,
    replay: args.context.replay,
    bookkeeping,
  });
  const retained = result.kind === 'terminal'
    ? null
    : this.host.runtimeTurnSupervisor.retain({
        context: args.context,
        attemptOutcome: args.attemptOutcome,
        answerEvidence,
        refreshAnswerEvidence: () => collectRuntimeTurnAnswerEvidence(
          args.queue,
          args.context.identity.logicalTurnId,
        ),
        bookkeeping,
        postEffects,
      }, result);
  if (result.kind === 'terminal') {
    if (!this.terminalPostEffectsAreProven(result)) {
      this.host.runtimeTurnSupervisor.markDegraded(args.context);
      return result;
    }
    await this.applyRuntimeTurnPostEffects(result, args.context, postEffects);
    this.finishRuntimeTurnContinuation(args.context);
  } else if (result.kind === 'durable_failure_incident' && retained?.mayAdvance === true) {
    await this.applyRuntimeTurnPostEffects(result, args.context, postEffects);
    this.host.runtimeTurnSupervisor.markPostEffectsApplied(args.context);
  }
  return result;
}

private terminalPostEffectsAreProven(
  result: Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }>,
): boolean {
  if (!result.receipt.winnerMatchesRequest) return false;
  if (result.terminal.inboundDisposition !== 'transferred_to_recovery_owner') return true;
  const recoveryJob = result.receipt.recoveryJob;
  if (
    recoveryJob === undefined
    || !['durably_queued', 'durably_blocked'].includes(recoveryJob.status)
  ) return false;
  if (result.effectiveReplyGuaranteeDisarmed) return true;
  return result.terminal.deliveryEvidence.kind === 'delivery_unknown'
    && recoveryJob.status === 'durably_blocked'
    && recoveryJob.state === 'blocked_unsafe';
}

async awaitActiveFinalizations(): Promise<void> {
  while (this.activeFinalizations.size > 0) {
    await Promise.allSettled([...this.activeFinalizations.values()]);
  }
}

async awaitUndispatchedCrashFinalizations(): Promise<void> {
  const active = [...this.undispatchedCrashFinalizations.entries()];
  const settled = await Promise.allSettled(active.map(([, finalization]) => finalization));
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected.length > 0) {
    throw new AggregateError(
      rejected.map((item) => item.reason),
      'undispatched runtime crash finalization failed',
    );
  }
  for (const [turnId] of active) {
    this.undispatchedCrashFinalizations.delete(turnId);
    this.cancelledUndispatchedTurnIds.delete(turnId);
  }
}

async awaitRejectedRuntimeTurnFinalizations(): Promise<void> {
  while (this.rejectedTurnFinalizations.size > 0) {
    await Promise.all([...this.rejectedTurnFinalizations]);
  }
  if (this.rejectedTurnFinalizationFailures.length === 0) return;
  const failures = this.rejectedTurnFinalizationFailures.splice(0);
  throw new AggregateError(failures, 'rejected runtime turn finalization failed');
}

async finalizeActiveRuntimeTurnsForShutdown(
  deadlineAt = Date.now() + RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isFinite(deadlineAt)) {
    throw new Error('Runtime turn shutdown deadline must be finite');
  }
  const activeQueue = this.host.getActiveQueue();
  const shutdownQueues = new Set<IOutboundQueue>([
    ...(activeQueue === null ? [] : [activeQueue]),
    ...this.host.chatQueues.values(),
  ]);
  for (const queue of shutdownQueues) queue.preemptForShutdown?.(deadlineAt);

  const pending: Promise<FinalizeRuntimeTurnResult>[] = [];
  const queueUndispatched = (turn: QueuedTurn): void => {
    if (!turn.runtimeContext) {
      if (turn.inboundSeq !== undefined) {
        pending.push(Promise.reject(
          new Error('Journaled shutdown turn has no immutable runtime turn context'),
        ));
      }
      return;
    }
    pending.push(this.finalizeUndispatchedRuntimeTurn(turn.runtimeContext));
  };
  for (const turn of this.host.turnQueue.closeAndTakePendingTurns()) queueUndispatched(turn);
  const pendingSingleton = this.host.pendingSingletonRuntimeTurnContext;
  if (
    pendingSingleton
    && this.host.currentRuntimeTurnContext?.identity.logicalTurnId
      !== pendingSingleton.identity.logicalTurnId
  ) {
    pending.push(this.terminalizeUndispatchedRuntimeCrash(pendingSingleton));
  }
  const current = this.host.currentRuntimeTurnContext;
  const activeGlobalTurn = this.host.turnQueue.activeTurn;
  if (
    activeGlobalTurn?.runtimeContext
    && current?.identity.logicalTurnId !== activeGlobalTurn.runtimeContext.identity.logicalTurnId
  ) {
    pending.push(this.finalizeUndispatchedRuntimeTurn(activeGlobalTurn.runtimeContext));
  }
  if (current && activeQueue) {
    activeQueue.abortTurn({ preserveEvidence: true });
    pending.push(this.finalizeRuntimeTurnContext({
      context: current,
      queue: activeQueue,
      attemptOutcome: { kind: 'failed', class: 'crash' },
      session: this.host.session,
      clearReplayOnSuccess: false,
    }));
  }
  for (const [mapKey, runtimeQueue] of this.host.perChatTurnQueues) {
    for (const turn of runtimeQueue.closeAndTakePendingTurns()) queueUndispatched(turn);
    const activeTurn = runtimeQueue.activeTurn;
    const published = this.host.perChatRuntimeTurnContexts.get(mapKey)?.[0];
    if (
      activeTurn?.runtimeContext
      && published?.identity.logicalTurnId !== activeTurn.runtimeContext.identity.logicalTurnId
    ) {
      this.host.chatQueues.get(mapKey)?.abortTurn();
      const scopeRef = this.host.perChatTurnQueueKeys.get(runtimeQueue) ?? { value: mapKey };
      pending.push(this.terminalizeUndispatchedRuntimeCrash(activeTurn.runtimeContext, scopeRef));
    }
  }
  for (const [mapKey, contexts] of this.host.perChatRuntimeTurnContexts) {
    const context = contexts[0];
    const queue = this.host.chatQueues.get(mapKey);
    if (!context || !queue) continue;
    queue.abortTurn({ preserveEvidence: true });
    pending.push(this.finalizeRuntimeTurnContext({
      context,
      queue,
      attemptOutcome: { kind: 'failed', class: 'crash' },
      session: this.host.chatSessions.get(mapKey) ?? null,
      mapKey,
      clearReplayOnSuccess: false,
    }));
  }
  const finalizationWork = (async (): Promise<PromiseSettledResult<FinalizeRuntimeTurnResult>[]> => {
    const results = await Promise.allSettled(pending);
    await this.awaitActiveFinalizations();
    return results;
  })();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let settled: PromiseSettledResult<FinalizeRuntimeTurnResult>[];
  try {
    settled = await Promise.race([
      finalizationWork,
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error('Runtime turn shutdown finalization deadline expired')),
          Math.max(0, deadlineAt - Date.now()),
        );
        deadlineTimer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  const unproven = settled.filter((item): item is PromiseFulfilledResult<FinalizeRuntimeTurnResult> => (
    item.status === 'fulfilled'
      && item.value.kind === 'terminal'
      && !this.terminalPostEffectsAreProven(item.value)
  ));
  const unresolved = settled.filter((item): item is PromiseFulfilledResult<FinalizeRuntimeTurnResult> => (
    item.status === 'fulfilled'
      && item.value.kind !== 'terminal'
      && !item.value.mayAdvance
  ));
  if (rejected.length > 0 || unproven.length > 0 || unresolved.length > 0) {
    throw new AggregateError(
      [
        ...rejected.map((item) => item.reason),
        ...unproven.map(() => new Error('Runtime turn terminal lacks exact shutdown release proof')),
        ...unresolved.map(() => new Error('Runtime turn finalization remains retry-owned during shutdown')),
      ],
      'active runtime turn shutdown finalization failed',
    );
  }
}

/**
 * Tear down one chat's runtime TurnQueue on an operator kill (/kill-session).
 *
 * /kill-session drops the SessionManager and the outbound queue, but the runtime
 * TurnQueue is a separate structure and it owns the turn *processor*. Left in
 * place it keeps accepting: the next inbound turn for that chat queues behind a
 * processor whose session no longer exists, never reaches sendTurnToSession /
 * spawnSession, and the chat deadlocks with its journaled row stuck open.
 *
 * Scoped mirror of the per-chat arm of finalizeActiveRuntimeTurnsForShutdown().
 */
async terminalizePerChatTurnQueueForKill(mapKey: string): Promise<void> {
  const runtimeQueue = this.host.perChatTurnQueues.get(mapKey);
  if (!runtimeQueue) return;
  const scopeRef = this.host.perChatTurnQueueKeys.get(runtimeQueue) ?? { value: mapKey };
  const pending: Promise<unknown>[] = [];

  // Never-dispatched turns: close admission and account for every journaled row.
  for (const turn of runtimeQueue.closeAndTakePendingTurns()) {
    if (!turn.runtimeContext) continue;
    pending.push(this.finalizeUndispatchedRuntimeTurnAndWait(turn.runtimeContext, scopeRef));
  }

  // Active turn: terminalize it unless the context was already published — a
  // published context is finalized by the caller's outbound-queue teardown.
  const activeTurn = runtimeQueue.activeTurn;
  const published = this.host.perChatRuntimeTurnContexts.get(mapKey)?.[0];
  if (
    activeTurn?.runtimeContext
    && published?.identity.logicalTurnId !== activeTurn.runtimeContext.identity.logicalTurnId
  ) {
    const activeContext = activeTurn.runtimeContext;
    pending.push(
      this.terminalizeUndispatchedRuntimeCrash(activeContext, scopeRef)
        .then(() => this.waitForUndispatchedRuntimeCrash(activeContext)),
    );
  }

  const settled = await Promise.allSettled(pending);
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected');

  // Drop the queue even if a finalization failed. A row that fails to finalize is
  // owned by runtimeTurnSupervisor and retried there; an orphaned TurnQueue is
  // retried by nobody and is the deadlock itself.
  this.host.perChatTurnQueues.delete(mapKey);

  if (rejected.length > 0) {
    throw new AggregateError(
      rejected.map((item) => item.reason),
      `kill-session runtime turn finalization failed for ${mapKey}`,
    );
  }
}

async applyRuntimeTurnPostEffects(
  result: Exclude<FinalizeRuntimeTurnResult, { kind: 'dual_sink_failure' }>,
  context: RuntimeTurnContext,
  postEffects: RuntimeTurnPostEffects,
): Promise<void> {
  const scopeKey = this.runtimeTurnScopeKey(context);
  const ledger = postEffects.ledger;
  const mapKey = postEffects.scopeRef?.value;
  if (!ledger.fifoValidated) {
    if (mapKey !== undefined) {
      const contexts = this.host.perChatRuntimeTurnContexts.get(mapKey);
      const seqs = this.host.perChatInboundSeqQueue.get(mapKey);
      const completion = this.host.perChatRuntimeTurnCompletions.get(mapKey);
      if (
        !postEffects.admissionRejected &&
        contexts?.[0]?.identity.logicalTurnId !== context.identity.logicalTurnId
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Per-chat runtime turn FIFO drift for ${scopeKey}`);
      }
      if (
        context.identity.inboundSeq !== null &&
        seqs?.[0] !== context.identity.inboundSeq
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Per-chat inbound sequence FIFO drift for ${scopeKey}`);
      }
      if (
        completion !== undefined
        && completion.context.identity.logicalTurnId !== context.identity.logicalTurnId
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Per-chat runtime turn completion drift for ${scopeKey}`);
      }
    } else {
      if (
        this.host.currentRuntimeTurnContext !== null
        && this.host.currentRuntimeTurnContext.identity.logicalTurnId !== context.identity.logicalTurnId
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Shared/singleton runtime turn FIFO drift for ${scopeKey}`);
      }
      if (
        context.identity.inboundSeq !== null
        && this.host.currentInboundSeq !== undefined
        && this.host.currentInboundSeq !== context.identity.inboundSeq
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Shared/singleton inbound sequence drift for ${scopeKey}`);
      }
      if (
        this.host.currentRuntimeTurnCompletion !== null
        && this.host.currentRuntimeTurnCompletion.context.identity.logicalTurnId !== context.identity.logicalTurnId
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Shared/singleton runtime turn completion drift for ${scopeKey}`);
      }
    }
    ledger.fifoValidated = true;
  }

  const shouldDisarm = result.kind === 'durable_failure_incident'
    ? result.mayAdvance
    : result.effectiveReplyGuaranteeDisarmed;
  if (shouldDisarm && !ledger.guaranteeDisarmed) {
    this.host.replyGuarantee?.disarm(context.identity.inboundSeq ?? undefined);
    ledger.guaranteeDisarmed = true;
  }
  if (!ledger.queueCleared) {
    postEffects.queue?.clearLastOpId();
    ledger.queueCleared = true;
  }
  if (mapKey !== undefined) {
    if (!ledger.fifoAdvanced) {
      const contexts = this.host.perChatRuntimeTurnContexts.get(mapKey);
      if (!postEffects.admissionRejected) {
        contexts!.shift();
        if (contexts!.length === 0) this.host.perChatRuntimeTurnContexts.delete(mapKey);
      }
      const seqs = this.host.perChatInboundSeqQueue.get(mapKey);
      seqs?.shift();
      if (seqs?.length === 0) this.host.perChatInboundSeqQueue.delete(mapKey);
      this.host.perChatExecActorQueue.get(mapKey)?.shift();
      this.host.perChatRuntimeTurnScopeRefs.delete(context.identity.logicalTurnId);
      ledger.fifoAdvanced = true;
    }
    if (postEffects.clearReplayOnSuccess && !ledger.replayCleared) {
      this.host.pendingTurnText.delete(mapKey);
      this.host.pendingTurnActorJid.delete(mapKey);
      ledger.replayCleared = true;
    }
    if (!ledger.presentationCleared) {
      this.host.perChatTurnContentType.delete(mapKey);
      this.host.perChatTurnText.delete(mapKey);
      this.host.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
      this.host.perChatAssistantItemText.delete(mapKey);
      ledger.presentationCleared = true;
    }
    if (result.kind === 'terminal' && !ledger.afterTerminalActionRun) {
      ledger.afterTerminalActionRun = true;
      const action = this.runRuntimeTurnAfterTerminalAction(context, result);
      if (action) await action;
    }
    if (!ledger.completionSettled) {
      const completion = this.host.perChatRuntimeTurnCompletions.get(mapKey);
      if (completion?.context.identity.logicalTurnId === context.identity.logicalTurnId) {
        this.host.perChatRuntimeTurnCompletions.delete(mapKey);
        completion.resolve();
      }
      ledger.completionSettled = true;
    }
  } else {
    if (!ledger.fifoAdvanced) {
      if (this.host.currentRuntimeTurnContext?.identity.logicalTurnId === context.identity.logicalTurnId) {
        this.host.currentRuntimeTurnContext = null;
      }
      if (this.host.currentInboundSeq === context.identity.inboundSeq) {
        this.host.currentInboundSeq = undefined;
      }
      this.host.currentTurnChatJid = null;
      this.host.currentTurnReplayText = null;
      this.host.currentTurnReplayActorJid = undefined;
      ledger.fifoAdvanced = true;
    }
    if (!ledger.presentationCleared) {
      this.host.currentTurnInboundContentType = null;
      this.host.currentTurnAssistantText = '';
      this.host.currentTurnAssistantItemText.clear();
      this.host.turnHadVisibleOutput = false;
      this.host.turnHadSuppressedReplySatisfaction = false;
      ledger.presentationCleared = true;
    }
    if (result.kind === 'terminal' && !ledger.afterTerminalActionRun) {
      ledger.afterTerminalActionRun = true;
      const action = this.runRuntimeTurnAfterTerminalAction(context, result);
      if (action) await action;
    }
    if (!ledger.completionSettled) {
      const completion = this.host.currentRuntimeTurnCompletion;
      if (completion?.context.identity.logicalTurnId === context.identity.logicalTurnId) {
        this.host.currentRuntimeTurnCompletion = null;
        completion.resolve();
      }
      ledger.completionSettled = true;
    }
  }

  if (
    !ledger.voiceScheduled &&
    postEffects.voice &&
    postEffects.voice.responseText &&
    config.voiceReply !== 'never' &&
    (config.voiceReply === 'always' || postEffects.voice.inboundContentType === 'audio')
  ) {
    ledger.voiceScheduled = true;
    void this.host.sendVoiceReply(postEffects.voice.chatJid, postEffects.voice.responseText);
  }
}

runRuntimeTurnAfterTerminalAction(
  context: RuntimeTurnContext,
  result: Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }>,
): Promise<void> | null {
  const turnId = context.identity.logicalTurnId;
  const action = this.host.runtimeTurnAfterTerminal.get(turnId);
  if (!action) return null;
  this.host.runtimeTurnAfterTerminal.delete(turnId);
  return Promise.resolve()
    .then(() => action(result))
    .catch((err: unknown) => {
      log.error({ err, logicalTurnId: turnId }, 'runtime after-terminal action failed');
    });
}

flushUnownedRuntimeResult(
  queue: IOutboundQueue,
  voice?: { chatJid: string; responseText: string; inboundContentType: string | null },
): void {
  queue.flush()
    .then(() => {
      if (
        voice &&
        voice.responseText &&
        config.voiceReply !== 'never' &&
        (config.voiceReply === 'always' || voice.inboundContentType === 'audio')
      ) {
        return this.host.sendVoiceReply(voice.chatJid, voice.responseText);
      }
    })
    .catch((err) => log.error({ err }, 'flush or voice reply failed'));
}

async retryRuntimeTurnFinalizations(): Promise<RuntimeTurnRetryResult> {
  return this.host.runtimeTurnSupervisor.retryAll();
}

async applyRecoveredRuntimeTurnFinalization(
  result: Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }>,
  retained: RetainedRuntimeTurnFinalization<RuntimeTurnPostEffects>,
): Promise<void> {
  if (!this.terminalPostEffectsAreProven(result)) {
    throw new Error('Recovered runtime terminal lacks an exact durable ownership handoff');
  }
  if (
    retained.postEffectsApplied ||
    (retained.postEffects.admissionRejected && retained.postEffects.scopeRef === undefined)
  ) {
    await this.runRuntimeTurnAfterTerminalAction(retained.context, result);
    if (result.effectiveReplyGuaranteeDisarmed) {
      this.host.replyGuarantee?.disarm(retained.context.identity.inboundSeq ?? undefined);
    }
    return;
  }
  const queue = retained.postEffects.queue;
  if (!queue && !retained.postEffects.admissionRejected) {
    throw new Error('Recovered runtime turn has no post-finalization queue');
  }
  await this.applyRuntimeTurnPostEffects(result, retained.context, retained.postEffects);
}

enqueuePerChatRuntimeTurn(mapKey: string, turn: QueuedTurn): boolean {
  if (this.host.isShuttingDown?.() === true) {
    // Shutdown-time admission rejection is a closed queue (#1750).
    this.finalizeRejectedRuntimeTurn(turn, 'queue_closed');
    return false;
  }
  let queue = this.host.perChatTurnQueues.get(mapKey);
  if (!queue) {
    const queueKey = { value: mapKey };
    queue = new TurnQueue({
      maxDepth: config.agentMaxQueueDepth,
      onReject: (rejected, reason) => {
        this.finalizeRejectedRuntimeTurn(rejected, reason);
        log.warn(
          { chatJid: rejected.chatJid, senderJid: rejected.senderJid, mapKey: queueKey.value, reason },
          'per-chat turn rejected — agent queue full or halted',
        );
      },
      onProcessorError: (failed, error) => this.finalizePerChatProcessorError(queueKey.value, failed, error),
    });
    queue.setProcessor((queued: QueuedTurn) => this.processPerChatTurn(queueKey, queued));
    this.host.perChatTurnQueues.set(mapKey, queue);
    this.host.perChatTurnQueueKeys.set(queue, queueKey);
  }
  return queue.enqueue(turn);
}

finalizeRejectedRuntimeTurn(turn: QueuedTurn, reason?: TurnRejectReason): void {
  const context = turn.runtimeContext;
  if (!context) {
    if (turn.inboundSeq !== undefined) {
      throw new Error('Journaled queue rejection has no immutable runtime turn context');
    }
    return;
  }
  // #1750: carry the distinct rejection reason into the admission outcome so it
  // lands as a distinct durable failure_class; absent stays legacy 'unknown'.
  const attemptOutcome: AttemptOutcome = reason === undefined
    ? { kind: 'admission_rejected' }
    : { kind: 'admission_rejected', class: reason };
  let tracked!: Promise<void>;
  tracked = this.finalizeUndispatchedRuntimeTurn(context, undefined, attemptOutcome)
    .then(async (result) => {
      if (result.kind !== 'terminal' && !result.mayAdvance) {
        await this.host.runtimeTurnSupervisor.waitForRecovery(context);
      }
    })
    .catch((err: unknown) => {
      this.host.runtimeTurnSupervisor.markDegraded(context);
      this.rejectedTurnFinalizationFailures.push(err);
      log.error(
        { err, scopeKey: this.runtimeTurnScopeKey(context) },
        'rejected runtime turn finalization failed',
      );
    })
    .finally(() => {
      this.rejectedTurnFinalizations.delete(tracked);
    });
  this.rejectedTurnFinalizations.add(tracked);
}

async finalizeUndispatchedRuntimeTurn(
  context: RuntimeTurnContext,
  scopeRef?: PerChatRuntimeScopeRef,
  attemptOutcome: AttemptOutcome = { kind: 'admission_rejected' },
): Promise<FinalizeRuntimeTurnResult> {
  if (!this.host.durability) {
    throw new Error('Journaled queue rejection requires durability');
  }

  const answerEvidence: RuntimeAnswerEvidence = { kind: 'ready', opIds: [] };
  // session is always null here (no SessionManager reference on this path), so
  // rowId is always null and the usage-loss alert in turnFinalizationBookkeeping
  // never fires for this call site regardless of attemptOutcome — passed through
  // for signature consistency, not because it changes behavior here.
  const bookkeeping = this.turnFinalizationBookkeeping(context, null, undefined, attemptOutcome);
  const postEffects = this.createRuntimeTurnPostEffects({
    queue: null,
    admissionRejected: true,
    ...(scopeRef === undefined ? {} : { scopeRef }),
  });
  const result = finalizeRuntimeTurn({
    instanceName: this.host.instanceName,
    durability: this.host.durability,
    identity: context.identity,
    attemptOutcome,
    answerEvidence,
    bookkeeping,
  });
  const scopeKey = this.runtimeTurnScopeKey(context);
  if (result.kind !== 'terminal') {
    const retained = this.host.runtimeTurnSupervisor.retain({
      context,
      attemptOutcome,
      answerEvidence,
      bookkeeping,
      postEffects,
    }, result);
    if (!retained.mayAdvance) {
      log.error(
        { scopeKey, failureStage: result.failureStage },
        'runtime turn finalization retained before FIFO release',
      );
      return result;
    }
    if (result.kind === 'durable_failure_incident') {
      if (scopeRef === undefined) {
        this.host.replyGuarantee?.disarm(context.identity.inboundSeq ?? undefined);
      } else {
        await this.applyRuntimeTurnPostEffects(result, context, postEffects);
      }
      this.host.runtimeTurnSupervisor.markPostEffectsApplied(context);
    }
    return result;
  }
  if (!this.terminalPostEffectsAreProven(result)) {
    this.host.runtimeTurnSupervisor.markDegraded(context);
    throw new Error(`Runtime turn terminal proof did not authorize FIFO release for ${scopeKey}`);
  }
  if (scopeRef !== undefined) {
    await this.applyRuntimeTurnPostEffects(result, context, postEffects);
  } else if (result.effectiveReplyGuaranteeDisarmed) {
    this.host.replyGuarantee?.disarm(context.identity.inboundSeq ?? undefined);
  }
  return result;
}

async finalizeUndispatchedRuntimeTurnAndWait(
  context: RuntimeTurnContext,
  scopeRef?: PerChatRuntimeScopeRef,
  attemptOutcome: AttemptOutcome = { kind: 'admission_rejected' },
): Promise<void> {
  const result = await this.finalizeUndispatchedRuntimeTurn(context, scopeRef, attemptOutcome);
  if (result.kind !== 'terminal' && !result.mayAdvance) {
    await this.host.runtimeTurnSupervisor.waitForRecovery(context);
  }
}

terminalizeUndispatchedRuntimeCrash(
  context: RuntimeTurnContext,
  scopeRef?: PerChatRuntimeScopeRef,
): Promise<FinalizeRuntimeTurnResult> {
  const turnId = context.identity.logicalTurnId;
  this.cancelledUndispatchedTurnIds.add(turnId);
  const initialFinalization = this.finalizeUndispatchedRuntimeTurn(
    context,
    scopeRef,
    { kind: 'failed', class: 'crash' },
  );
  const finalization = initialFinalization.then(async (result) => {
    if (result.kind !== 'terminal' && !result.mayAdvance) {
      await this.host.runtimeTurnSupervisor.waitForRecovery(context);
    }
  }).catch((err: unknown) => {
    this.host.runtimeTurnSupervisor.markDegraded(context);
    log.error(
      { err, mapKey: scopeRef?.value, scopeKey: this.runtimeTurnScopeKey(context) },
      'undispatched runtime crash finalization failed',
    );
    throw err;
  });
  this.undispatchedCrashFinalizations.set(turnId, finalization);
  void finalization.catch(() => {});
  return initialFinalization;
}

isUndispatchedRuntimeTurnCancelled(context: RuntimeTurnContext): boolean {
  return this.cancelledUndispatchedTurnIds.has(context.identity.logicalTurnId);
}

clearUndispatchedRuntimeTurnCancellation(context: RuntimeTurnContext): void {
  const turnId = context.identity.logicalTurnId;
  this.cancelledUndispatchedTurnIds.delete(turnId);
  this.undispatchedCrashFinalizations.delete(turnId);
}

async waitForUndispatchedRuntimeCrash(context: RuntimeTurnContext): Promise<void> {
  await this.undispatchedCrashFinalizations.get(context.identity.logicalTurnId);
}

finalizeMessageProcessingFailure(inboundSeq: number | undefined): boolean {
  if (inboundSeq === undefined) return false;
  let mapKey: string | undefined;
  let context = this.host.currentRuntimeTurnContext?.identity.inboundSeq === inboundSeq
    ? this.host.currentRuntimeTurnContext
    : null;
  if (!context) {
    for (const [candidateKey, contexts] of this.host.perChatRuntimeTurnContexts) {
      const candidate = contexts.find(
        (item: RuntimeTurnContext) => item.identity.inboundSeq === inboundSeq,
      );
      if (candidate) {
        context = candidate;
        mapKey = candidateKey;
        break;
      }
    }
  }
  if (!context) return false;
  const queue = mapKey === undefined
    ? this.host.getActiveQueue()
    : this.host.chatQueues.get(mapKey);
  if (!queue) return false;
  const session = mapKey === undefined
    ? this.host.session
    : this.host.chatSessions.get(mapKey) ?? null;
  void this.finalizeRuntimeTurnContext({
    context,
    queue,
    attemptOutcome: { kind: 'failed', class: 'processor_throw' },
    session,
    ...(mapKey === undefined ? {} : { mapKey }),
    clearReplayOnSuccess: false,
  });
  return true;
}

async finalizePerChatProcessorError(
  mapKey: string,
  turn: QueuedTurn,
  error: unknown,
): Promise<void> {
  const context = turn.runtimeContext;
  if (!context) {
    throw new Error('Per-chat processor failure has no immutable runtime turn context', { cause: error });
  }
  if (
    this.host.perChatRuntimeTurnContexts.get(mapKey)?.[0]?.identity.logicalTurnId
      !== context.identity.logicalTurnId
  ) {
    if (this.isUndispatchedRuntimeTurnCancelled(context)) {
      await this.waitForUndispatchedRuntimeCrash(context);
      this.clearUndispatchedRuntimeTurnCancellation(context);
      return;
    }
    await this.finalizeUndispatchedRuntimeTurnAndWait(
      context,
      { value: mapKey },
      { kind: 'admission_rejected', class: 'pre_dispatch_error' },
    );
    return;
  }
  const queue = this.host.getQueueForChat(turn.chatJid, mapKey);
  if (!queue) {
    throw new Error(`Per-chat processor failure has no outbound queue for "${mapKey}"`, { cause: error });
  }
  const result = await this.finalizeRuntimeTurnContext({
    context,
    queue,
    attemptOutcome: { kind: 'failed', class: 'processor_throw' },
    session: this.host.chatSessions.get(mapKey) ?? null,
    mapKey,
    clearReplayOnSuccess: true,
  });
  if (result.kind !== 'terminal' && !result.mayAdvance) {
    await this.host.runtimeTurnSupervisor.waitForRecovery(context);
  }
}

async finalizeSharedProcessorError(
  turn: QueuedTurn,
  error: unknown,
): Promise<void> {
  const context = turn.runtimeContext;
  if (!context) {
    if (turn.inboundSeq === undefined) {
      this.host.getQueueForChat(turn.chatJid)?.abortTurn();
      this.host.replyGuarantee?.disarm(undefined);
      this.host.currentInboundSeq = undefined;
      this.host.currentRuntimeTurnContext = null;
      this.host.currentTurnChatJid = null;
      this.host.currentTurnReplayText = null;
      this.host.currentTurnReplayActorJid = undefined;
      return;
    }
    throw new Error('Shared processor failure has no immutable runtime turn context', { cause: error });
  }
  if (
    this.host.currentRuntimeTurnContext?.identity.logicalTurnId
      !== context.identity.logicalTurnId
  ) {
    await this.finalizeUndispatchedRuntimeTurnAndWait(
      context,
      undefined,
      { kind: 'admission_rejected', class: 'pre_dispatch_error' },
    );
    if (this.host.currentInboundSeq === context.identity.inboundSeq) {
      this.host.getQueueForChat(turn.chatJid)?.setInboundSeq(undefined);
      this.host.currentInboundSeq = undefined;
      this.host.currentTurnChatJid = null;
      this.host.currentTurnReplayText = null;
      this.host.currentTurnReplayActorJid = undefined;
      this.host.currentTurnInboundContentType = null;
      this.host.currentTurnAssistantText = '';
      this.host.currentTurnAssistantItemText.clear();
      this.host.turnHadVisibleOutput = false;
      this.host.turnHadSuppressedReplySatisfaction = false;
    }
    return;
  }
  const queue = this.host.getQueueForChat(turn.chatJid);
  if (!queue) {
    throw new Error('Shared processor failure has no outbound queue', { cause: error });
  }
  const result = await this.finalizeRuntimeTurnContext({
    context,
    queue,
    attemptOutcome: { kind: 'failed', class: 'processor_throw' },
    session: this.host.session,
  });
  if (result.kind !== 'terminal' && !result.mayAdvance) {
    await this.host.runtimeTurnSupervisor.waitForRecovery(context);
  }
}

finalizeRuntimeCrash(
  context: RuntimeTurnContext | null | undefined,
  queue: IOutboundQueue | null | undefined,
  session: SessionManager | null,
  mapKey?: string,
): void {
  if (!context || !queue || !this.host.durability) {
    if (!context && this.host.currentInboundSeq === undefined) {
      queue?.abortTurn();
      return;
    }
    queue?.abortTurn({ preserveEvidence: true });
    if (context || this.host.currentInboundSeq !== undefined) {
      log.error(
        { mapKey, inboundSeq: context?.identity.inboundSeq ?? this.host.currentInboundSeq },
        'journaled crash could not reach immutable terminal finalization',
      );
    }
    return;
  }
  queue.abortTurn({ preserveEvidence: true });
  void this.finalizeRuntimeTurnContext({
    context,
    queue,
    attemptOutcome: { kind: 'failed', class: 'crash' },
    session,
    ...(mapKey === undefined ? {} : { mapKey }),
    clearReplayOnSuccess: false,
  }).catch((err: unknown) => {
    this.host.runtimeTurnSupervisor.markDegraded(context);
    log.error({ err, mapKey, scopeKey: this.runtimeTurnScopeKey(context) },
      'runtime crash finalization escaped');
  });
}

async processPerChatTurn(
  scopeRef: PerChatRuntimeScopeRef,
  turn: QueuedTurn,
  // PRESTAGE-T4: set only when the turn-recovery supervisor is calling this
  // directly (not via the live-message queue path) to dispatch a claimed
  // job's replay — see beginRuntimeTurnEvidence's doc comment for why.
  excludeJobId?: number,
): Promise<void> {
  const mapKey = scopeRef.value;
  const seqQueue = this.host.perChatInboundSeqQueue.get(mapKey) ?? [];
  if (turn.inboundSeq !== undefined) seqQueue.push(turn.inboundSeq);
  this.host.perChatInboundSeqQueue.set(mapKey, seqQueue);
  this.host.getQueueForChat(turn.chatJid, mapKey)?.setInboundSeq(turn.inboundSeq);
  this.host.replyGuarantee?.arm({ inboundSeq: turn.inboundSeq, chatJid: turn.chatJid });
  this.host.perChatTurnSourceMessageId.set(mapKey, turn.sourceMessageId);
  this.host.perChatTurnContentType.set(mapKey, turn.contentType);
  this.host.perChatTurnText.set(mapKey, '');
  this.host.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
  this.host.perChatAssistantItemText.delete(mapKey);
  if (config.nlRouting) this.host.perChatRouteMarkerHold.set(mapKey, '');
  else this.host.perChatRouteMarkerHold.delete(mapKey);

  let dispatchError: unknown;
  let dispatchFailed = false;
  try {
    await this.host.sendTurnPerChat(
      turn.chatJid,
      turn.text,
      mapKey,
      turn.senderJid,
      turn.runtimeContext,
      scopeRef,
      undefined,
      excludeJobId,
    );
  } catch (err) {
    dispatchFailed = true;
    dispatchError = err;
  }
  if (turn.runtimeContext) {
    const cancelled = this.isUndispatchedRuntimeTurnCancelled(turn.runtimeContext);
    if (cancelled) {
      await this.waitForUndispatchedRuntimeCrash(turn.runtimeContext);
      this.clearUndispatchedRuntimeTurnCancellation(turn.runtimeContext);
      return;
    }
    this.clearUndispatchedRuntimeTurnCancellation(turn.runtimeContext);
  }
  if (dispatchFailed) throw dispatchError;
}

}
