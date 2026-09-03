import { randomUUID } from 'node:crypto';
import { systemClock } from '../../lib/clock.ts';
import type { CapabilityDecisionParams } from '../../core/capability-obligation-store.ts';
import type { ContentType } from '../../core/types.ts';
import type {
  DurabilityEngine,
  TurnFinalizationBookkeepingParams,
} from '../../core/durability.ts';
import { splitInputTokenUsage, type AgentEvent } from './stream-parser.ts';
import { classifyProviderFailure } from './failure-taxonomy.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import type { ExecutingSessionContext, SessionContext } from '../../mcp/types.ts';
import {
  TurnQueue,
  type QueuedTurn,
  type TurnQueueTeardownReceipt,
  type TurnRejectReason,
} from './turn-queue.ts';
import { TurnQueueHaltLatch, type TurnQueueHaltHealth } from './turn-queue-halt-latch.ts';
import {
  OutboundQueuePoisonRegistry,
  type OutboundQueuePoisonHealth,
} from './outbound-queue-poison-registry.ts';
import { GLOBAL_CONVERSATION_KEY } from '../../core/conversation-key.ts';
import {
  ScopeBlockedByDurableRecoveryError,
  ScopeBlockedByFinalizationRecoveryError,
  admissionRejectionLogFields,
} from './turn-admission-errors.ts';
import { attemptOutcomeToken, classifyTurnLane, runtimeLifecycleEmitter, type LifecycleEmitInput } from '../../core/observability/lifecycle-emission.ts';
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
import type { TurnDeliveryKind } from './turn-chronology.ts';
import {
  createRuntimeTurnCompletionValue,
  rejectRuntimeTurnCompletionValue,
  type RuntimeTurnCompletion,
} from './runtime-turn-completion.ts';
import { discardCancelledPreBoundaryPerChatTurn } from './runtime-turn-pre-boundary-cancellation.ts';
import {
  replayTurnOnFallback as replayTurnOnFallbackForHost,
  type ProviderFallbackReplayArgs,
  type ResolvedReplayRoute,
} from './fallback-replay.ts';

export {
  FallbackReplayInvalidatedError,
  FallbackReplayOwnershipChangedError,
  FallbackReplayRouteChangedError,
} from './fallback-replay.ts';
export type { ProviderFallbackReplayArgs, ResolvedReplayRoute } from './fallback-replay.ts';

export type { RuntimeTurnCompletion } from './runtime-turn-completion.ts';
const log = createChildLogger('agent-runtime');
export const RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS = 2_000;

/**
 * #2976 residual: retire the turn's actor from a session's stored MCP conduit
 * at turn end. Optional-called (like updateSessionActorJid in runtime.ts) so a
 * partial session double that omits the method is a safe no-op; the real
 * SessionManager always implements clearMcpActorJid.
 */
function clearSessionMcpActor(session: SessionManager | null | undefined): void {
  (session as (SessionManager & { clearMcpActorJid?: () => void }) | null | undefined)
    ?.clearMcpActorJid?.();
}

export interface RuntimeTurnSourceSnapshot {
  readonly sourceMessageId: string;
  readonly receivedAtUnixSeconds: number;
  readonly conversationKey: string;
  readonly senderJid: string;
  readonly senderName: string | null;
  readonly contentType: ContentType;
  readonly isGroup: boolean;
  readonly groupName?: string;
}

export interface PerChatRuntimeScopeRef {
  value: string;
}

export interface RuntimeTurnPostEffects {
  readonly queue: IOutboundQueue | null;
  readonly scopeRef?: PerChatRuntimeScopeRef;
  readonly clearReplayOnSuccess?: boolean;
  readonly admissionRejected?: boolean;
  readonly advancePerChatInboundSeq?: boolean;
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

export interface RuntimeTurnQueueTeardown {
  readonly scope: 'global' | 'per_chat';
  readonly mapKey?: string;
  readonly queue: TurnQueue | null;
  readonly receipt: TurnQueueTeardownReceipt | null;
  disposition: 'interruption' | 'kill' | null;
}

interface RuntimeTurnQueueTeardownState {
  readonly transaction: RuntimeTurnQueueTeardown;
  readonly terminalization: Promise<RuntimeTurnQueueTeardown>;
  readonly resolveTerminalization: (transaction: RuntimeTurnQueueTeardown) => void;
  readonly rejectTerminalization: (error: unknown) => void;
  readonly lifecycle: Promise<void>;
  readonly resolveLifecycle: () => void;
  retirement: Promise<void> | null;
}

// #2398: scopes whose finalization escaped without a durable retry owner.
// Tracked both in-memory (fast path) and on disk (restart survival).
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const STUCK_SCOPE_STORE_DIR = join(homedir(), '.local', 'state', 'bot-errors', 'stuck-scopes');
const STUCK_SCOPE_STORE_FILE = join(STUCK_SCOPE_STORE_DIR, 'stuck.json');

export const STUCK_FINALIZATION_SCOPES: Set<string> = new Set();

function saveStuckScopes(): void {
  try {
    mkdirSync(STUCK_SCOPE_STORE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STUCK_SCOPE_STORE_FILE, JSON.stringify([...STUCK_FINALIZATION_SCOPES]), { mode: 0o600 });
  } catch (err) {
    // A lost write silently defeats the durable registration this store
    // exists for — surface it even though the turn itself must proceed.
    log.warn({ err }, 'stuck-scope store write failed; escape registration not durable');
  }
}

function loadStuckScopes(): string[] {
  try {
    if (!existsSync(STUCK_SCOPE_STORE_FILE)) return [];
    const data = readFileSync(STUCK_SCOPE_STORE_FILE, 'utf-8');
    return JSON.parse(data) as string[];
  } catch { return []; }
}

export function registerStuckScope(scopeKey: string): void {
  STUCK_FINALIZATION_SCOPES.add(scopeKey);
  saveStuckScopes();
}

export function hasStuckScope(scopeKey: string): boolean {
  return STUCK_FINALIZATION_SCOPES.has(scopeKey);
}

export function drainStuckScopes(): string[] {
  const scopes = [...STUCK_FINALIZATION_SCOPES];
  STUCK_FINALIZATION_SCOPES.clear();
  try {
    unlinkSync(STUCK_SCOPE_STORE_FILE);
  } catch (err) {
    log.warn({ err }, 'stuck-scope store unlink failed after drain; stale file may resurrect scopes on restart');
  }
  return scopes;
}

/** Call on coordinator startup: emits missing recovery clears for any
 * scopes that were stuck at last shutdown (restart survival). */
export function reconcileStuckScopes(instanceName: string): void {
  const scopes = loadStuckScopes();
  if (scopes.length === 0) return;
  // Emit clears so the durable incident resolves even after restart
  for (const scopeKey of scopes) {
    STUCK_FINALIZATION_SCOPES.delete(scopeKey);
  }
  try {
    unlinkSync(STUCK_SCOPE_STORE_FILE);
  } catch (err) {
    log.warn({ err }, 'stuck-scope store unlink failed after reconcile; stale file may resurrect scopes on restart');
  }
}

export interface RuntimeTurnCoordinatorPort {
  readonly durability: DurabilityEngine | null;
  readonly instanceName: string;
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  /**
   * #3295 S2: live per-admission read of the deferred-turn flag (kill-switch
   * semantics). Optional so narrow test hosts keep compiling; absent = OFF.
   */
  deferredTurnAdmissionEnabled?(): boolean;
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
  replaceGlobalTurnQueue(expected: TurnQueue): void;
  readonly perChatTurnQueues: Map<string, TurnQueue>;
  readonly perChatTurnQueueKeys: WeakMap<TurnQueue, PerChatRuntimeScopeRef>;
  readonly perChatExecActorQueue: Map<string, ExecutingSessionContext[]>;
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
  /**
   * The event tool scope key the runtime registered for this session. Throws
   * for a session the runtime never created, which is fail-closed: a dispatch
   * whose target has no scope cannot have its events admitted anyway.
   */
  requireSessionToolScopeKey(session: SessionManager): string;
  /**
   * Capability-obligation replay: derive the C3 decision for a finalizing
   * turn (undefined = the turn owes nothing / feature inert). Runs BEFORE
   * `finalizeTurnTerminal` so media staging precedes the transaction (D3).
   */
  deriveCapabilityDecision?(
    context: RuntimeTurnContext,
    session: SessionManager | null,
  ): Promise<CapabilityDecisionParams | undefined>;
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
    deliveryKind?: TurnDeliveryKind,
    dispatchAllowed?: () => boolean,
    onProviderBoundary?: () => void,
    purpose?: SessionContext['purpose'],
  ): Promise<void>;
  deleteOwnedPerChatSession(mapKey: string, expected?: SessionManager): boolean;
  discardPerChatSessionForFallback(mapKey: string, expected: SessionManager): boolean;
  discardSingletonSessionForFallback(expected: SessionManager): boolean;
  recreatePerChatSessionForFallback(
    mapKey: string,
    chatJid: string,
    actorJid?: string,
    routeOverride?: ResolvedReplayRoute,
  ): void;
  recreateSingletonSessionForFallback(
    chatJid: string,
    actorJid?: string,
    routeOverride?: ResolvedReplayRoute,
  ): void;
  isReplayRouteCurrent(
    chatJid: string,
    actorJid: string | undefined,
    routeOverride: ResolvedReplayRoute,
  ): boolean;
  bindActiveGlobalMcpConversation(chatJid: string): void;
  sendTurnToSession(
    session: SessionManager,
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    beforeUserSend?: () => void,
    systemTurnLease?: SystemTurnLeaseToken,
    dispatchAllowed?: () => boolean,
    runtimeContext?: RuntimeTurnContext,
    deliveryKind?: TurnDeliveryKind,
    purpose?: SessionContext['purpose'],
  ): Promise<void>;
  sendVoiceReply(chatJid: string, responseText: string): Promise<void>;
}

/**
 * #3374 ask 2: thrown into a pinned per-chat processor when the W2 sweep has
 * durably reclaimed its turn's inbound row. Signals the processor-error
 * finalizer that the durable terminal is ALREADY owned by the sweep — a
 * non-terminal finalization result must advance the queue instead of parking
 * on a recovery that can never arrive (the row is already failed).
 */
export class WedgedTurnReclaimedError extends Error {
  constructor() {
    super('WEDGED_TURN_RECLAIMED');
    this.name = 'WedgedTurnReclaimedError';
  }
}

/**
 * #3295 S2: thrown by `beginRuntimeTurnEvidence` when a recovery-blocked,
 * replay-safe follower was DEFERRED into a durable obligation instead of
 * being terminally rejected. The processor-error path recognizes it and
 * retires the runtime turn state WITHOUT any durable inbound mutation — the
 * obligation row is the turn's durable owner from this point on.
 */
export class TurnDeferredToObligationError extends Error {
  readonly obligationId: number;

  constructor(obligationId: number) {
    super('TURN_DEFERRED_TO_OBLIGATION');
    this.name = 'TurnDeferredToObligationError';
    this.obligationId = obligationId;
  }
}

/**
 * Terminal-equivalent retirement marker for a deferred turn: post-effects
 * (FIFO shift, reply-guarantee disarm, presentation clear) apply exactly as
 * for an admission-rejected turn, but no `finalizeRuntimeTurn` runs — the
 * inbound row stays `processing`, owned by the obligation. Deliberately NOT
 * part of `FinalizeRuntimeTurnResult`: `finalizeRuntimeTurn` can never
 * return it, so no finalization consumer needs to handle it.
 */
interface DeferredToObligationRetirement {
  readonly kind: 'deferred_to_obligation';
  readonly mayAdvance: true;
}

export class RuntimeTurnCoordinator {
  private readonly host: RuntimeTurnCoordinatorPort;
  private readonly turnQueueHalts = new TurnQueueHaltLatch();
  private readonly outboundQueuePoisons = new OutboundQueuePoisonRegistry();
  private readonly activeFinalizations = new Map<string, Promise<FinalizeRuntimeTurnResult>>();
  private readonly cancelledUndispatchedTurnIds = new Set<string>();
  private readonly undispatchedCrashFinalizations = new Map<string, Promise<void>>();
  private readonly rejectedTurnFinalizations = new Set<Promise<void>>();
  private readonly rejectedTurnFinalizationFailures: unknown[] = [];
  private globalTeardown: RuntimeTurnQueueTeardownState | null = null;
  private readonly perChatTeardowns = new Map<string, RuntimeTurnQueueTeardownState>();
  private readonly continuationDeferrals = new Map<string, {
    initialResultConsumed: boolean;
    cancelled: boolean;
    readonly consumed: Promise<void>;
    readonly resolveConsumed: () => void;
  }>();

  constructor(host: RuntimeTurnCoordinatorPort) {
    this.host = host;
  }

turnQueueHaltHealth(sessionScope: 'single' | 'shared' | 'per_chat'): TurnQueueHaltHealth {
  return this.turnQueueHalts.snapshot(sessionScope, this.host.turnQueue.isHalted);
}
rekeyPerChatTurnQueueHaltScope(fromScopeKey: string, toScopeKey: string): void {
  this.turnQueueHalts.rekey(fromScopeKey, toScopeKey);
}

outboundQueuePoisonHealth(): OutboundQueuePoisonHealth {
  return this.outboundQueuePoisons.snapshot();
}

isOutboundQueuePoisoned(scopeKey: string): boolean {
  return this.outboundQueuePoisons.has(scopeKey);
}

rekeyPerChatOutboundQueuePoisonScope(fromScopeKey: string, toScopeKey: string): void {
  this.outboundQueuePoisons.rekey(fromScopeKey, toScopeKey);
}

async observeOutboundQueueOperation<T>(
  scopeKey: string,
  queue: IOutboundQueue,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    this.observeOutboundQueueFailure(scopeKey, queue, error);
    throw error;
  }
}

private observeOutboundQueueFailure(
  scopeKey: string,
  queue: IOutboundQueue,
  error: unknown,
): void {
  if (!queue.isPoisoned()) return;
  try {
    this.containOutboundQueuePoison(scopeKey, error);
  } catch (containmentError) {
    log.error({ err: containmentError }, 'outbound queue poison containment failed');
  }
}

rejectRuntimeTurnIfOutboundQueuePoisoned(scopeKey: string, turn: QueuedTurn): boolean {
  if (!this.outboundQueuePoisons.has(scopeKey)) return false;
  this.finalizeRejectedRuntimeTurn(turn, 'scope_blocked_recovery');
  return true;
}

enqueueSharedRuntimeTurn(turn: QueuedTurn): boolean {
  if (this.host.isShuttingDown?.() === true) {
    this.finalizeRejectedRuntimeTurn(turn, 'queue_closed');
    return false;
  }
  if (this.rejectRuntimeTurnIfOutboundQueuePoisoned(GLOBAL_CONVERSATION_KEY, turn)) {
    return false;
  }
  return this.host.turnQueue.enqueue(turn);
}

private containOutboundQueuePoison(scopeKey: string, error: unknown): void {
  this.outboundQueuePoisons.record(scopeKey, error);
  const poisonCause = this.outboundQueuePoisons.cause(scopeKey);
  if (this.host.sessionScope === 'per_chat') this.turnQueueHalts.halt(scopeKey);
  const turnQueue = this.host.sessionScope === 'per_chat'
    ? this.host.perChatTurnQueues.get(scopeKey)
    : this.host.turnQueue;
  for (const pending of turnQueue?.haltAndTakePendingTurns(poisonCause) ?? []) {
    this.finalizeRejectedRuntimeTurn(pending, 'scope_blocked_recovery');
  }
}

private retryOutboundQueuePoisonContainment(scopeKey: string): void {
  if (!this.outboundQueuePoisons.has(scopeKey)) return;
  this.containOutboundQueuePoison(scopeKey, this.outboundQueuePoisons.cause(scopeKey));
}

hasGlobalTeardownPending(): boolean {
  return this.globalTeardown !== null;
}

hasPerChatTeardownPending(mapKey: string): boolean {
  return this.perChatTeardowns.has(mapKey);
}

private createTeardownState(
  transaction: RuntimeTurnQueueTeardown,
): RuntimeTurnQueueTeardownState {
  let resolveTerminalization!: (transaction: RuntimeTurnQueueTeardown) => void;
  let rejectTerminalization!: (error: unknown) => void;
  const terminalization = new Promise<RuntimeTurnQueueTeardown>((resolve, reject) => {
    resolveTerminalization = resolve;
    rejectTerminalization = reject;
  });
  // The initiating caller observes the enclosing async method's rejection.
  // This internal promise exists so overlapping callers can join that exact
  // attempt; attach a sink for the no-overlap case without changing what
  // joiners observe.
  void terminalization.catch(() => undefined);
  let resolveLifecycle!: () => void;
  const lifecycle = new Promise<void>((resolve) => {
    resolveLifecycle = resolve;
  });
  return {
    transaction,
    terminalization,
    resolveTerminalization,
    rejectTerminalization,
    lifecycle,
    resolveLifecycle,
    retirement: null,
  };
}

private async awaitTeardownLifecyclesForShutdown(deadlineAt: number): Promise<void> {
  while (this.globalTeardown !== null || this.perChatTeardowns.size > 0) {
    const active = [
      ...(this.globalTeardown === null ? [] : [this.globalTeardown.lifecycle]),
      ...[...this.perChatTeardowns.values()].map((state) => state.lifecycle),
    ];
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(active),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error('Runtime turn teardown lifecycle deadline expired')),
            Math.max(0, deadlineAt - Date.now()),
          );
          deadlineTimer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
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
  // The tool scope has to move with the manager. Tool scope keys are
  // incarnation-specific (`createToolScopeKey` appends a monotonic ordinal), so
  // when the eviction repair replaces a stale mapped session the turn is
  // dispatched to a session whose scope the inbound context has never seen.
  // Rebinding manager and generation alone leaves the predecessor's scope in
  // the context that provider-event admission compares against, and the
  // replacement's own terminal is then rejected as unowned: the dispatched turn
  // runs, its completion never settles, and the chat stays pinned behind the
  // FIFO conflict guard until the wedged-lane sweep's 24h grace releases it.
  return rebindRuntimeTurnOwner(context, {
    managerId: owner.managerId,
    generation: owner.generation,
    toolScopeKey: this.host.requireSessionToolScopeKey(session),
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

isRuntimeTurnContinuation(context: RuntimeTurnContext): boolean {
  return this.continuationDeferrals.has(context.identity.logicalTurnId);
}

async replayTurnOnFallback(args: ProviderFallbackReplayArgs): Promise<void> {
  return replayTurnOnFallbackForHost(this.host, args);
}

markRuntimeTurnDegraded(context: RuntimeTurnContext): void {
  this.host.runtimeTurnSupervisor.markDegraded(context);
}

rejectRuntimeTurnCompletion(
  error: unknown,
  mapKey?: string,
  expectedContext?: RuntimeTurnContext,
): boolean {
  return rejectRuntimeTurnCompletionValue(this.host, error, mapKey, expectedContext);
}

runtimeTurnScopeKey(context: RuntimeTurnContext): string {
  return this.host.runtimeTurnSupervisor.scopeKey(context);
}

createRuntimeTurnCompletion(context: RuntimeTurnContext): RuntimeTurnCompletion {
  return createRuntimeTurnCompletionValue(context);
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
      receivedAtUnixSeconds: args.source.receivedAtUnixSeconds,
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
/**
 * FLOS Stage 1 (plan §3): emit one turn-scoped lifecycle event. Lane and
 * `trigger_occurrence_id` derive from the #2566 synthetic message id; the
 * work_id is the source message id so occurrence-layer and turn-layer
 * events join into one chain. emit() is phase-gated and never throws.
 */
private emitTurnLifecyclePhase(
  context: RuntimeTurnContext,
  phase: 'admitted' | 'acknowledged' | 'terminal_result' | 'finalized',
  attrs?: LifecycleEmitInput['attrs'],
): void {
  const cls = classifyTurnLane(context.replay?.sourceMessageId);
  runtimeLifecycleEmitter().emit({
    lane: cls.lane,
    work_id: context.replay?.sourceMessageId ?? context.identity.logicalTurnId,
    phase,
    correlation: {
      logical_turn_id: context.identity.logicalTurnId,
      generation: context.identity.generation,
      ...(context.identity.inboundSeq === null ? {} : { inbound_seq: context.identity.inboundSeq }),
      ...(cls.lane === 'L-SCH' ? { trigger_occurrence_id: cls.trigger_occurrence_id } : {}),
    },
    ...(attrs === undefined ? {} : { attrs }),
  });
}

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
    // #3295 S2 (flag default OFF, read per admission): a follower blocked
    // SOLELY by outstanding recovery — this predicate, before any dispatch —
    // that is replay-safe becomes a durable obligation instead of a terminal
    // admission rejection. Every other rejection class (including the
    // supervisor check below) keeps the terminal path bit-for-bit.
    const deferred = this.maybeDeferRecoveryBlockedTurn(context, durability);
    if (deferred !== null) throw deferred;
    throw new ScopeBlockedByDurableRecoveryError();
  }
  if (!this.host.runtimeTurnSupervisor.canAccept(context)) {
    throw new ScopeBlockedByFinalizationRecoveryError();
  }
  queue.beginTurnEvidence(context.identity.logicalTurnId);
  // FLOS Stage 1: the turn passed every admission gate above. A scheduled
  // turn was already admitted+dispatched at the occurrence layer, so this
  // seam is the turn chain ACKNOWLEDGING the dispatched work; an interactive
  // turn enters the system here and is ADMITTED.
  this.emitTurnLifecyclePhase(
    context,
    classifyTurnLane(context.replay?.sourceMessageId).lane === 'L-SCH' ? 'acknowledged' : 'admitted',
  );
}

/**
 * #3295 S2 deferral predicate + enqueue. Returns the typed error to throw
 * when the recovery-blocked turn was deferred, or null to keep the terminal
 * path. Deferrable = flag ON (live read) AND per_chat scope (the wedge class
 * from the issue; shared/singleton keep the terminal path in S2) AND a
 * journaled inbound AND a replay-safe text envelope with no dispatch started
 * (this seam is pre-dispatch by construction).
 */
private maybeDeferRecoveryBlockedTurn(
  context: RuntimeTurnContext,
  durability: DurabilityEngine,
): TurnDeferredToObligationError | null {
  if (this.host.deferredTurnAdmissionEnabled?.() !== true) return null;
  if (context.identity.scope !== 'per_chat') return null;
  if (context.identity.inboundSeq === null) return null;
  const replay = context.replay;
  if (replay === undefined || replay.replaySafe !== true) return null;
  if (context.contentType !== 'text') return null;
  try {
    const enqueued = durability.deferredTurns.enqueueDeferredObligation({
      scope: context.identity.scope,
      conversationKey: context.identity.conversationKey,
      deliveryJid: context.identity.deliveryJid,
      inboundSeq: context.identity.inboundSeq,
      sourceMessageId: replay.sourceMessageId,
      // Live source snapshots can carry a non-finite receive time (NaN from
      // an absent upstream timestamp — it would bind as NULL); deferral order
      // is by inbound_seq, so a now-stamp keeps the row honest without a read.
      receivedAtUnixSeconds: Number.isFinite(replay.receivedAtUnixSeconds)
        ? replay.receivedAtUnixSeconds
        : systemClock.nowUnixSec(),
      replaySafe: replay.replaySafe,
      senderJid: replay.senderJid,
      senderName: replay.senderName ?? null,
      text: replay.text,
      isGroup: replay.isGroup,
      groupName: replay.groupName ?? null,
      contentType: context.contentType,
      toolScopeKey: context.toolScopeKey ?? null,
    });
    log.info(
      {
        inboundSeq: context.identity.inboundSeq,
        obligationId: enqueued.id,
        deduplicated: enqueued.deduplicated,
        scopeKey: this.runtimeTurnScopeKey(context),
      },
      'recovery-blocked follower deferred into durable obligation (#3295 S2)',
    );
    return new TurnDeferredToObligationError(enqueued.id);
  } catch (err) {
    // Fail toward today's behavior: if the obligation cannot be recorded the
    // follower keeps the terminal admission-rejection path — deferral must
    // never turn an explicit loss into a silent one.
    log.error(
      { err, inboundSeq: context.identity.inboundSeq },
      'deferred-turn enqueue failed — keeping terminal admission rejection',
    );
    return null;
  }
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
    // The `scope` above is the turn-scope KIND (per_chat | shared | singleton),
    // not a conversation, and it is confined to metadata at the emission
    // boundary regardless. The conversation must ride its own field or the
    // dispatcher — which keys incidents on machine|instance|source — files
    // every chat's rejection into whichever chat opened the incident first.
    // The raw key is never emitted: buildBotErrorsEvent projects it to a
    // bounded digest.
    emitAlertChecked(
      this.host.instanceName,
      'agent_turn_admission_rejected',
      'Journaled agent turn rejected before dispatch',
      `inbound_seq=${context.identity.inboundSeq} reason=${reason} automatic_replay=false scope=${context.identity.scope}`,
      'warning',
      undefined,
      undefined,
      { conversationKey: context.identity.conversationKey },
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
        ...(
          status?.active === undefined
          || status.durableFailureClosed === true
          || status.durableFailureInconclusive === true
          ? {}
          : { sessionStatus: status.active ? 'active' : 'suspended' }
        ),
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
  // FLOS Stage 1: a provider result event means a terminal result existed
  // for this attempt; `finalized` is emitted only when finalization actually
  // settles (a rejected finalization leaves the chain honestly unfinalized).
  if (args.event !== undefined) {
    this.emitTurnLifecyclePhase(args.context, 'terminal_result', {
      attempt_outcome: attemptOutcomeToken(args.attemptOutcome.kind),
    });
  }
  void finalization.then(
    () => { this.emitTurnLifecyclePhase(args.context, 'finalized'); },
    () => {},
  );
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
  const scopeRef = args.mapKey === undefined
    ? undefined
    : this.host.perChatRuntimeTurnScopeRefs.get(args.context.identity.logicalTurnId)
      ?? { value: args.mapKey };
  const scopeKey = scopeRef?.value ?? GLOBAL_CONVERSATION_KEY;
  const answerEvidence = await collectRuntimeTurnAnswerEvidence(
    args.queue,
    args.context.identity.logicalTurnId,
    (error) => this.observeOutboundQueueFailure(scopeKey, args.queue, error),
  );
  const postEffects = this.createRuntimeTurnPostEffects({
    queue: args.queue,
    ...(scopeRef === undefined ? {} : { scopeRef }),
    ...(args.clearReplayOnSuccess === undefined
      ? {}
      : { clearReplayOnSuccess: args.clearReplayOnSuccess }),
    ...(args.voice === undefined ? {} : { voice: args.voice }),
  });
  let capabilityDecision: CapabilityDecisionParams | undefined;
  if (this.host.deriveCapabilityDecision !== undefined) {
    try {
      capabilityDecision = await this.host.deriveCapabilityDecision(args.context, args.session);
    } catch (err) {
      // A producer fault must neither block finalization NOR lose the signal
      // silently — record a typed not_created audit event in its place.
      log.error({ err, logicalTurnId: args.context.identity.logicalTurnId }, 'capability decision producer failed');
      capabilityDecision = {
        auditEvent: {
          action: 'obligation.not_created',
          actorType: 'runtime',
          reasonCode: 'not_created_decision_producer_error',
        },
      };
    }
  }
  const result = finalizeRuntimeTurn({
    instanceName: this.host.instanceName,
    durability: this.host.durability,
    identity: args.context.identity,
    attemptOutcome: args.attemptOutcome,
    answerEvidence,
    recoveryOwner: args.context.recoveryOwner,
    replay: args.context.replay,
    bookkeeping,
    ...(capabilityDecision === undefined ? {} : { capabilityDecision }),
  });
  const retained = result.kind === 'terminal' || result.kind === 'reclaimed_by_sweep'
    ? null
    : this.host.runtimeTurnSupervisor.retain({
        context: args.context,
        attemptOutcome: args.attemptOutcome,
        answerEvidence,
        refreshAnswerEvidence: () => collectRuntimeTurnAnswerEvidence(
          args.queue,
          args.context.identity.logicalTurnId,
          (error) => this.observeOutboundQueueFailure(scopeKey, args.queue, error),
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
  } else if (result.kind === 'reclaimed_by_sweep') {
    // The sweep owns the durable terminal (#3374 ask 2): retire the runtime
    // state exactly like a terminal — no retention, no incident.
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

private assertResetFinalizations(
  settled: PromiseSettledResult<FinalizeRuntimeTurnResult>[],
  message: string,
): void {
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
  if (rejected.length === 0 && unproven.length === 0 && unresolved.length === 0) return;
  throw new AggregateError(
    [
      ...rejected.map((item) => item.reason),
      ...unproven.map(() => new Error('Runtime turn terminal lacks exact reset release proof')),
      ...unresolved.map(() => new Error('Runtime turn finalization remains retry-owned during reset')),
    ],
    message,
  );
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
  // A reset/kill owns its TurnQueue from beginTeardown through exact
  // retirement. Joining that lifecycle prevents shutdown from trying to
  // close the same queue receipt or racing the reset's session teardown.
  await this.awaitTeardownLifecyclesForShutdown(deadlineAt);
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
 * Durably terminalize the exact published singleton/shared turn before /new
 * releases its session and queue ownership. The runtime TurnQueue may still
 * report processing after its legacy flags clear, so immutable contexts are
 * the authority here.
 */
async terminalizeGlobalTurnForReset(): Promise<RuntimeTurnQueueTeardown> {
  const existing = this.globalTeardown;
  if (existing) {
    if (
      existing.transaction.queue === null
      || this.host.turnQueue !== existing.transaction.queue
    ) {
      throw new Error('Cannot resume a superseded singleton/shared runtime TurnQueue teardown');
    }
    return existing.terminalization;
  }
  const finalizations: Promise<FinalizeRuntimeTurnResult>[] = [];
  const runtimeQueue = this.host.turnQueue;
  const teardown = runtimeQueue.beginTeardown();
  const transaction: RuntimeTurnQueueTeardown = {
    scope: 'global',
    queue: runtimeQueue,
    receipt: teardown,
    disposition: null,
  };
  const state = this.createTeardownState(transaction);
  this.globalTeardown = state;
  // In-place mutation — callers hold a reference to `transaction` (reference
  // equality is load-bearing for the teardown lifecycle).
  transaction.disposition = 'interruption';
  const detachedFinalizations: Array<{
    readonly turn: QueuedTurn;
    settledIndex: number | null;
    ownershipProven: boolean;
  }> = [];
  const current = this.host.currentRuntimeTurnContext;
  for (const turn of teardown.pending) {
    const detached: (typeof detachedFinalizations)[number] = {
      turn,
      settledIndex: null,
      ownershipProven: false,
    };
    detachedFinalizations.push(detached);
    if (!turn.runtimeContext) {
      if (turn.inboundSeq !== undefined) {
        detached.settledIndex = finalizations.length;
        finalizations.push(Promise.reject(
          new Error('Journaled singleton/shared reset turn has no immutable runtime turn context'),
        ));
      }
      continue;
    }
    detached.settledIndex = finalizations.length;
    finalizations.push(this.finalizeUndispatchedRuntimeTurn(
      turn.runtimeContext,
      undefined,
      { kind: 'admission_rejected' },
      () => { detached.ownershipProven = true; },
    ));
  }
  const pendingSingleton = this.host.pendingSingletonRuntimeTurnContext;
  if (
    pendingSingleton
    && current?.identity.logicalTurnId !== pendingSingleton.identity.logicalTurnId
  ) {
    finalizations.push(this.terminalizeUndispatchedRuntimeCrash(pendingSingleton));
  }
  const activeTurn = runtimeQueue.activeTurn;
  if (
    activeTurn?.runtimeContext
    && current?.identity.logicalTurnId !== activeTurn.runtimeContext.identity.logicalTurnId
    && pendingSingleton?.identity.logicalTurnId !== activeTurn.runtimeContext.identity.logicalTurnId
  ) {
    finalizations.push(this.terminalizeUndispatchedRuntimeCrash(activeTurn.runtimeContext));
  }
  if (current) {
    const queue = this.host.getQueueForChat(current.identity.deliveryJid);
    if (!queue) {
      finalizations.push(Promise.reject(
        new Error('Published singleton/shared reset turn has no outbound queue'),
      ));
    } else {
      queue.abortTurn({ preserveEvidence: true });
      const finalization = this.finalizeRuntimeTurnContext({
        context: current,
        queue,
        attemptOutcome: { kind: 'failed', class: 'crash' },
        session: this.host.session,
        clearReplayOnSuccess: false,
      });
      finalizations.push(finalization);
    }
  }

  const settled = await Promise.allSettled(finalizations);
  try {
    this.assertResetFinalizations(
      settled,
      'singleton/shared reset turn finalization failed',
    );
  } catch (err) {
    const unresolved = detachedFinalizations.flatMap((detached) => (
      !detached.ownershipProven
      && (
        detached.settledIndex === null
        || settled[detached.settledIndex]?.status === 'rejected'
      )
        ? [detached.turn]
        : []
    ));
    let failure: unknown = err;
    let rollbackSucceeded = false;
    try {
      runtimeQueue.rollbackFailedTeardown(
        teardown,
        unresolved,
        this.host.turnQueue === runtimeQueue,
      );
      rollbackSucceeded = true;
    } catch (rollbackError) {
      failure = new AggregateError(
        [err, rollbackError],
        'singleton/shared reset teardown rollback failed',
      );
    }
    if (rollbackSucceeded) {
      try {
        this.retryOutboundQueuePoisonContainment(GLOBAL_CONVERSATION_KEY);
      } catch (containmentError) {
        failure = new AggregateError(
          [failure, containmentError],
          'singleton/shared reset poison containment retry failed',
        );
      }
    }
    if (rollbackSucceeded && this.globalTeardown === state) {
      this.globalTeardown = null;
      state.resolveLifecycle();
    }
    state.rejectTerminalization(failure);
    throw failure;
  }
  state.resolveTerminalization(transaction);
  return transaction;
}

async retireGlobalTurnQueueAfterReset(transaction: RuntimeTurnQueueTeardown): Promise<void> {
  const state = this.globalTeardown;
  if (
    transaction.scope !== 'global'
    || transaction.queue === null
    || transaction.receipt === null
    || state?.transaction !== transaction
  ) {
    throw new Error('Singleton/shared runtime TurnQueue teardown receipt is not current');
  }
  if (state.retirement) return state.retirement;
  const queue = transaction.queue;
  const receipt = transaction.receipt;
  const attempt = (async (): Promise<void> => {
    if (this.host.turnQueue !== queue) {
      throw new Error('Cannot retire a superseded singleton/shared runtime TurnQueue');
    }
    await queue.awaitRetirementQuiescence();
    if (this.host.turnQueue !== queue) {
      throw new Error('Cannot retire a superseded singleton/shared runtime TurnQueue');
    }
    queue.commitTeardown(receipt);
    this.host.replaceGlobalTurnQueue(queue);
    if (this.globalTeardown !== state) {
      throw new Error('Singleton/shared runtime TurnQueue teardown changed during retirement');
    }
    this.globalTeardown = null;
    state.resolveLifecycle();
  })();
  const retirement = attempt.catch((error) => {
    if (state.retirement === retirement) state.retirement = null;
    throw error;
  });
  state.retirement = retirement;
  return retirement;
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
async terminalizePerChatTurnQueueForKill(mapKey: string): Promise<RuntimeTurnQueueTeardown> {
  const existing = this.perChatTeardowns.get(mapKey);
  if (existing) {
    if (
      (this.host.perChatTurnQueues.get(mapKey) ?? null)
      !== existing.transaction.queue
    ) {
      throw new Error(`Cannot resume a superseded per-chat runtime TurnQueue teardown for ${mapKey}`);
    }
    return existing.terminalization;
  }
  const runtimeQueue = this.host.perChatTurnQueues.get(mapKey);
  const teardown = runtimeQueue?.beginTeardown();
  const transaction: RuntimeTurnQueueTeardown = {
    scope: 'per_chat',
    mapKey,
    queue: runtimeQueue ?? null,
    receipt: teardown ?? null,
    disposition: null,
  };
  const state = this.createTeardownState(transaction);
  this.perChatTeardowns.set(mapKey, state);
  // In-place mutation — callers hold a reference to `transaction` (reference
  // equality is load-bearing for the teardown lifecycle).
  transaction.disposition = 'kill';
  const scopeRef = runtimeQueue === undefined
    ? { value: mapKey }
    : this.host.perChatTurnQueueKeys.get(runtimeQueue) ?? { value: mapKey };
  const finalizations: Promise<FinalizeRuntimeTurnResult>[] = [];
  const detachedFinalizations: Array<{
    readonly turn: QueuedTurn;
    settledIndex: number | null;
    ownershipProven: boolean;
  }> = [];

  // Never-dispatched turns: close admission and account for every journaled row.
  if (teardown) {
    for (const turn of teardown.pending) {
      const detached: (typeof detachedFinalizations)[number] = {
        turn,
        settledIndex: null,
        ownershipProven: false,
      };
      detachedFinalizations.push(detached);
      if (!turn.runtimeContext) {
        if (turn.inboundSeq !== undefined) {
          detached.settledIndex = finalizations.length;
          finalizations.push(Promise.reject(
            new Error(`Journaled per-chat reset turn has no immutable runtime turn context for ${mapKey}`),
          ));
        }
        continue;
      }
      detached.settledIndex = finalizations.length;
      finalizations.push(this.finalizeUndispatchedRuntimeTurn(
        turn.runtimeContext,
        scopeRef,
        { kind: 'admission_rejected' },
        () => { detached.ownershipProven = true; },
      ));
    }
  }

  // Active turn: terminalize it unless the context was already published — a
  // published context is terminalized directly below before ownership is lost.
  const activeTurn = runtimeQueue?.activeTurn;
  const published = this.host.perChatRuntimeTurnContexts.get(mapKey)?.[0];
  if (
    activeTurn?.runtimeContext
    && published?.identity.logicalTurnId !== activeTurn.runtimeContext.identity.logicalTurnId
  ) {
    finalizations.push(this.terminalizeUndispatchedRuntimeCrash(activeTurn.runtimeContext, scopeRef));
  }
  if (published) {
    const queue = this.host.chatQueues.get(mapKey);
    if (!queue) {
      finalizations.push(Promise.reject(
        new Error(`Published per-chat kill turn has no outbound queue for ${mapKey}`),
      ));
    } else {
      queue.abortTurn({ preserveEvidence: true });
      const finalization = this.finalizeRuntimeTurnContext({
        context: published,
        queue,
        attemptOutcome: { kind: 'failed', class: 'crash' },
        session: this.host.chatSessions.get(mapKey) ?? null,
        mapKey,
        clearReplayOnSuccess: false,
      });
      finalizations.push(finalization);
    }
  }

  const settled = await Promise.allSettled(finalizations);
  try {
    this.assertResetFinalizations(
      settled,
      `kill-session runtime turn finalization failed for ${mapKey}`,
    );
  } catch (err) {
    let failure: unknown = err;
    let rollbackSucceeded = runtimeQueue === undefined || teardown === undefined;
    if (runtimeQueue && teardown) {
      const unresolved = detachedFinalizations.flatMap((detached) => (
        !detached.ownershipProven
        && (
          detached.settledIndex === null
          || settled[detached.settledIndex]?.status === 'rejected'
        )
          ? [detached.turn]
          : []
      ));
      try {
        runtimeQueue.rollbackFailedTeardown(
          teardown,
          unresolved,
          this.host.perChatTurnQueues.get(mapKey) === runtimeQueue,
        );
        rollbackSucceeded = true;
      } catch (rollbackError) {
        failure = new AggregateError(
          [err, rollbackError],
          `per-chat reset teardown rollback failed for ${mapKey}`,
        );
      }
    }
    if (rollbackSucceeded) {
      try {
        this.retryOutboundQueuePoisonContainment(mapKey);
      } catch (containmentError) {
        failure = new AggregateError(
          [failure, containmentError],
          `per-chat reset poison containment retry failed for ${mapKey}`,
        );
      }
    }
    if (rollbackSucceeded && this.perChatTeardowns.get(mapKey) === state) {
      this.perChatTeardowns.delete(mapKey);
      state.resolveLifecycle();
    }
    state.rejectTerminalization(failure);
    throw failure;
  }
  state.resolveTerminalization(transaction);
  return transaction;
}

async retirePerChatTurnQueueAfterKill(transaction: RuntimeTurnQueueTeardown): Promise<void> {
  const mapKey = transaction.mapKey;
  const state = mapKey === undefined ? undefined : this.perChatTeardowns.get(mapKey);
  if (
    transaction.scope !== 'per_chat'
    || mapKey === undefined
    || state?.transaction !== transaction
  ) {
    throw new Error('Per-chat runtime TurnQueue teardown receipt is not current');
  }
  if (state.retirement) return state.retirement;
  const attempt = (async (): Promise<void> => {
    if (this.host.perChatTurnQueues.get(mapKey) !== (transaction.queue ?? undefined)) {
      throw new Error(`Cannot retire a superseded per-chat runtime TurnQueue for ${mapKey}`);
    }
    if (transaction.queue && transaction.receipt) {
      await transaction.queue.awaitRetirementQuiescence();
      if (this.host.perChatTurnQueues.get(mapKey) !== transaction.queue) {
        throw new Error(`Cannot retire a superseded per-chat runtime TurnQueue for ${mapKey}`);
      }
      transaction.queue.commitTeardown(transaction.receipt);
      this.host.perChatTurnQueues.delete(mapKey);
    }
    if (this.perChatTeardowns.get(mapKey) !== state) {
      throw new Error(`Per-chat runtime TurnQueue teardown changed during retirement for ${mapKey}`);
    }
    this.perChatTeardowns.delete(mapKey);
    state.resolveLifecycle();
  })();
  const retirement = attempt.catch((error) => {
    if (state.retirement === retirement) state.retirement = null;
    throw error;
  });
  state.retirement = retirement;
  return retirement;
}

/**
 * Route recycling is admitted only after AgentRuntime.isTurnInFlight proves
 * this scope idle. Re-prove that state at the mutation choke point, then close
 * and retire synchronously so a "recycled" receipt cannot race a next inbound
 * onto either the old session or a closed TurnQueue.
 */
captureIdlePerChatTurnQueueForRecycle(mapKey: string): TurnQueue | null {
  const runtimeQueue = this.host.perChatTurnQueues.get(mapKey);
  const hasRuntimeOwner = (
    (this.host.perChatInboundSeqQueue.get(mapKey)?.length ?? 0) > 0
    || (this.host.perChatRuntimeTurnContexts.get(mapKey)?.length ?? 0) > 0
    || this.host.perChatRuntimeTurnCompletions.has(mapKey)
  );
  if (
    hasRuntimeOwner
    || runtimeQueue?.isProcessing === true
    || (runtimeQueue?.pending ?? 0) > 0
    || runtimeQueue?.activeTurn !== null && runtimeQueue?.activeTurn !== undefined
  ) {
    throw new Error(`Cannot recycle non-idle per-chat runtime TurnQueue for ${mapKey}`);
  }
  return runtimeQueue ?? null;
}

retireIdlePerChatTurnQueueForRecycle(
  mapKey: string,
  expectedQueue: TurnQueue | null,
): void {
  const runtimeQueue = this.captureIdlePerChatTurnQueueForRecycle(mapKey);
  if (runtimeQueue !== expectedQueue) {
    throw new Error(`Per-chat runtime TurnQueue ownership changed during recycle for ${mapKey}`);
  }
  if (!runtimeQueue) return;
  const pending = runtimeQueue.closeAndTakePendingTurns();
  if (pending.length > 0) {
    throw new Error(`Per-chat runtime TurnQueue changed during recycle for ${mapKey}`);
  }
  if (this.host.perChatTurnQueues.get(mapKey) !== runtimeQueue) {
    throw new Error(`Per-chat runtime TurnQueue was superseded during recycle for ${mapKey}`);
  }
  this.host.perChatTurnQueues.delete(mapKey);
}

async applyRuntimeTurnPostEffects(
  result: Exclude<FinalizeRuntimeTurnResult, { kind: 'dual_sink_failure' }> | DeferredToObligationRetirement,
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
        (!postEffects.admissionRejected || postEffects.advancePerChatInboundSeq) &&
        context.identity.inboundSeq !== null &&
        seqs?.[0] !== context.identity.inboundSeq
      ) {
        this.host.runtimeTurnSupervisor.markDegraded(context);
        throw new Error(`Per-chat inbound sequence FIFO drift for ${scopeKey}`);
      }
      if (
        !postEffects.admissionRejected &&
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

  const shouldDisarm = result.kind === 'terminal'
    ? result.effectiveReplyGuaranteeDisarmed
    : result.mayAdvance;
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
      if (!postEffects.admissionRejected || postEffects.advancePerChatInboundSeq) {
        const seqs = this.host.perChatInboundSeqQueue.get(mapKey);
        seqs?.shift();
        if (seqs?.length === 0) this.host.perChatInboundSeqQueue.delete(mapKey);
        this.host.perChatExecActorQueue.get(mapKey)?.shift();
        // #2976 residual: retire the turn's actor from the per-chat session's
        // stored MCP conduit at the same seam the executing-actor register is
        // retired, so it cannot linger onto the next turn. Optional-called like
        // updateSessionActorJid (runtime.ts) — partial session doubles omit it.
        clearSessionMcpActor(this.host.chatSessions.get(mapKey));
      }
      this.host.perChatRuntimeTurnScopeRefs.delete(context.identity.logicalTurnId);
      ledger.fifoAdvanced = true;
    }
    if (postEffects.clearReplayOnSuccess && !ledger.replayCleared) {
      this.host.pendingTurnText.delete(mapKey);
      this.host.pendingTurnActorJid.delete(mapKey);
      ledger.replayCleared = true;
    }
    if (
      !ledger.presentationCleared
      && (!postEffects.admissionRejected || postEffects.advancePerChatInboundSeq)
    ) {
      this.host.perChatTurnContentType.delete(mapKey);
      this.host.perChatTurnText.delete(mapKey);
      this.host.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
      this.host.perChatAssistantItemText.delete(mapKey);
      ledger.presentationCleared = true;
    } else if (postEffects.admissionRejected && !postEffects.advancePerChatInboundSeq) {
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
      // #2976 (ii): retire the executing-turn actor for the global-socket
      // resolver (pushed at the provider boundary; admission-rejected turns
      // never pushed, so nothing to shift there).
      if (!postEffects.admissionRejected) {
        this.host.perChatExecActorQueue.get(GLOBAL_CONVERSATION_KEY)?.shift();
        // #2976 residual: retire the turn's actor from the shared/single
        // session's stored MCP conduit at the same seam, so it cannot linger
        // onto the next turn (the in-process bridge reads it defensively).
        clearSessionMcpActor(this.host.session);
      }
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
  scopeKey: string,
  voice?: { chatJid: string; responseText: string; inboundContentType: string | null },
): void {
  this.observeOutboundQueueOperation(scopeKey, queue, () => queue.flush())
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
  result: Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' | 'reclaimed_by_sweep' }>,
  retained: RetainedRuntimeTurnFinalization<RuntimeTurnPostEffects>,
): Promise<void> {
  if (result.kind === 'reclaimed_by_sweep') {
    // A retained finalization whose row the sweep later reclaimed: the sweep
    // owns the durable terminal; only the in-memory retirement remains.
    if (!retained.postEffectsApplied) {
      await this.applyRuntimeTurnPostEffects(result, retained.context, retained.postEffects);
    }
    return;
  }
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
  if (this.rejectRuntimeTurnIfOutboundQueuePoisoned(mapKey, turn)) {
    return false;
  }
  if (this.turnQueueHalts.has(mapKey)) {
    this.finalizeRejectedRuntimeTurn(turn, 'queue_halted');
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
      onHalt: () => {
        this.turnQueueHalts.halt(queueKey.value);
      },
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
  onOwnershipProven?: () => void,
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
      advancePerChatInboundSeq:
        scopeRef !== undefined
        && context.identity.inboundSeq !== null
        && this.host.perChatInboundSeqQueue.get(scopeRef.value)?.[0]
          === context.identity.inboundSeq,
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
  if (result.kind === 'reclaimed_by_sweep') {
    // The sweep owns the durable terminal: retire the in-memory state only.
    onOwnershipProven?.();
    if (scopeRef !== undefined) {
      await this.applyRuntimeTurnPostEffects(result, context, postEffects);
    } else {
      this.host.replyGuarantee?.disarm(context.identity.inboundSeq ?? undefined);
    }
    return result;
  }
  if (result.kind !== 'terminal') {
    const retained = this.host.runtimeTurnSupervisor.retain({
      context,
      attemptOutcome,
      answerEvidence,
      bookkeeping,
      postEffects,
    }, result);
    onOwnershipProven?.();
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
  onOwnershipProven?.();
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
  rejection?: { error: unknown; fifoHead?: { turnId: string | undefined } },
): Promise<void> {
  if (rejection !== undefined) {
    // Diagnosability (2026-08-29 q DM wedge): record WHICH gate rejected and
    // (per-chat) what held the FIFO head. Deliberately one warn per rejected
    // turn — a wedged scope's rejection stream IS the forensic trail this
    // incident lacked. Lives here so per_chat AND shared/singleton processor
    // errors get the same record.
    log.warn(
      admissionRejectionLogFields(
        scopeRef?.value ?? context.identity.scope,
        context,
        rejection.error,
        rejection.fifoHead,
      ),
      'pre-dispatch turn rejection — finalizing failed with no replay',
    );
  }
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
  void finalization.catch((err) => log.debug({ err }, 'runtime-turn-coordinator: undispatched crash finalization rejected (consumed at its await site; barrier only)'));
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

/**
 * #3295 S2: retire a deferred turn's runtime state through the standard
 * admission-rejected post-effects (inbound-seq FIFO advance, reply-guarantee
 * disarm, presentation clear) with ZERO durable writes — the obligation row
 * enqueued at admission is the turn's durable owner.
 */
private async retireDeferredRuntimeTurn(
  context: RuntimeTurnContext,
  scopeRef: PerChatRuntimeScopeRef,
): Promise<void> {
  const postEffects = this.createRuntimeTurnPostEffects({
    queue: null,
    admissionRejected: true,
    advancePerChatInboundSeq:
      context.identity.inboundSeq !== null
      && this.host.perChatInboundSeqQueue.get(scopeRef.value)?.[0]
        === context.identity.inboundSeq,
    scopeRef,
  });
  await this.applyRuntimeTurnPostEffects(
    { kind: 'deferred_to_obligation', mayAdvance: true },
    context,
    postEffects,
  );
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
  const fifoHeadTurnId = this.host.perChatRuntimeTurnContexts.get(mapKey)?.[0]?.identity.logicalTurnId;
  if (fifoHeadTurnId !== context.identity.logicalTurnId) {
    // #3295 S2: the deferral throw happens pre-publication (the context never
    // entered the FIFO), so it always lands in this branch. Retire the
    // runtime state with NO durable inbound mutation — the obligation row
    // recorded at admission owns the turn now.
    if (error instanceof TurnDeferredToObligationError) {
      await this.retireDeferredRuntimeTurn(context, { value: mapKey });
      return;
    }
    if (this.isUndispatchedRuntimeTurnCancelled(context)) {
      await this.waitForUndispatchedRuntimeCrash(context);
      this.clearUndispatchedRuntimeTurnCancellation(context);
      return;
    }
    await this.finalizeUndispatchedRuntimeTurnAndWait(
      context,
      { value: mapKey },
      { kind: 'admission_rejected', class: 'pre_dispatch_error' },
      { error, fifoHead: { turnId: fifoHeadTurnId } },
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
    if (error instanceof WedgedTurnReclaimedError) {
      // FALLBACK ONLY: a reclaimed turn normally finalizes as
      // reclaimed_by_sweep (mayAdvance) and never reaches this branch. If the
      // finalizer could not prove sweep ownership (e.g. the row read failed),
      // parking would re-create the exact queue wedge the reclaim is
      // releasing — advance instead.
      log.warn(
        { mapKey, scopeKey: this.runtimeTurnScopeKey(context), resultKind: result.kind },
        'wedged-turn reclaim finalization is non-terminal — durable ownership already held by the stale-reclaim sweep; advancing queue',
      );
      return;
    }
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
      { error },
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
  // #3398: set ONLY by the runtime's provider-crash wrapper. The fence-lost
  // replay abort (abortTurnRecoveryReplay) reaches here too and must stay
  // quiet — a lane that lost its claim goes silent while the new claimant
  // owns delivery — so salvage is opt-in per call site, and the salvage send
  // is status-role (never answer evidence), leaving this function's crash
  // finalization classes untouched.
  options: { salvageOwedReply?: boolean } = {},
): void {
  const salvageOwedReply = options.salvageOwedReply === true;
  if (!context || !queue || !this.host.durability) {
    if (!context && this.host.currentInboundSeq === undefined) {
      queue?.abortTurn();
      return;
    }
    queue?.abortTurn({ preserveEvidence: true, ...(salvageOwedReply ? { salvageOwedReply } : {}) });
    if (context || this.host.currentInboundSeq !== undefined) {
      log.error(
        { mapKey, inboundSeq: context?.identity.inboundSeq ?? this.host.currentInboundSeq },
        'journaled crash could not reach immutable terminal finalization',
      );
    }
    return;
  }
  queue.abortTurn({ preserveEvidence: true, ...(salvageOwedReply ? { salvageOwedReply } : {}) });
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
  dispatchAllowed?: () => boolean,
  onProviderBoundary?: () => void,
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
  let providerBoundaryCrossed = false;
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
      undefined,
      dispatchAllowed,
      () => {
        providerBoundaryCrossed = true;
        onProviderBoundary?.();
      },
      turn.purpose,
    );
  } catch (err) {
    dispatchFailed = true;
    dispatchError = err;
  }
  if (!providerBoundaryCrossed && dispatchAllowed?.() === false) {
    discardCancelledPreBoundaryPerChatTurn(this.host, mapKey, turn);
    return;
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

  // #2398: register a scope whose finalization escaped — the retry sweep
  // will pick it up and attempt recovery.
  registerStuckScope(scopeKey: string): void {
    STUCK_FINALIZATION_SCOPES.add(scopeKey);
  }
}
