/**
 * Shared harness for the runtime terminal coordinator integration suite.
 *
 * Physical extraction per the 2026-07-11 turn-lifecycle fitness design: the
 * runtime state view, context builder, durability/reply-guarantee mocks,
 * queue/session stubs, messenger fake, and the runtime-state factory live here
 * behind named exports. Hoisted mocks and vi.mock declarations stay in the
 * test file (Vitest hoisting requirement).
 */
import { vi } from 'vitest';

import type { Database } from '../../../../src/core/database.ts';
import type { IOutboundQueue } from '../../../../src/runtimes/agent/outbound-queue.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../../src/runtimes/agent/runtime.ts';
import { createRuntimeTurnContext, type RuntimeTurnContext } from '../../../../src/runtimes/agent/runtime-turn-context.ts';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import type { SessionOwnershipRegistry } from '../../../../src/runtimes/agent/session-ownership.ts';
import type { QueuedTurn } from '../../../../src/runtimes/agent/turn-queue.ts';
import type {
  FinalizeTurnTerminalResult,
  OutboundDeliverySnapshot,
} from '../../../../src/core/durability.ts';

export interface RuntimeState {
  durability: ReturnType<typeof durabilityMock>;
  replyGuarantee: ReturnType<typeof replyGuaranteeMock>;
  perChatRuntimeTurnContexts: Map<string, RuntimeTurnContext[]>;
  perChatInboundSeqQueue: Map<string, number[]>;
  perChatTurnQueues: Map<string, {
    activeTurn: QueuedTurn | null;
    idle(): Promise<void>;
  }>;
  currentRuntimeTurnContext: RuntimeTurnContext | null;
  currentInboundSeq?: number;
  currentTurnChatJid: string | null;
  activeChatJid: string | null;
  turnHadVisibleOutput: boolean;
  outboundQueues: Map<string, IOutboundQueue>;
  chatQueues: Map<string, IOutboundQueue>;
  chatSessions: Map<string, ReturnType<typeof sessionStub>>;
  perChatRuntimeTurnScopeRefs: Map<string, { value: string }>;
  pendingTurnText: Map<string, string>;
  runtimeTurnAfterTerminal: Map<string, (result: unknown) => void | Promise<void>>;
  scheduleFallbackReplay(args: {
    activation: {
      primaryProvider: string;
      fallbackProvider: string;
      fallbackModel: string | undefined;
      reason: 'usage-limit';
      resetAt: Date | null;
      activeUntil: number;
      extended: boolean;
      keyPresent: boolean | null;
      recoveryProbeRequired: boolean;
    };
    chatJid: string;
    mapKey?: string;
    oldSession: ReturnType<typeof sessionStub> | null;
    hadToolActivity: boolean;
  }): boolean;
  replayTurnOnFallback(args: unknown): Promise<void>;
  notifyProviderFallbackActivated(
    queue: IOutboundQueue,
    activation: {
      primaryProvider: string;
      fallbackProvider: string;
      fallbackModel: string | undefined;
      reason: 'usage-limit';
      resetAt: Date | null;
      activeUntil: number;
      extended: boolean;
      keyPresent: boolean | null;
      recoveryProbeRequired: boolean;
    },
    replay: { replayScheduled: boolean; blockedByToolActivity?: boolean },
  ): void;
  runtimeTurnCoordinator: {
    finalizeRuntimeTurnContext(args: {
      context: RuntimeTurnContext;
      queue: IOutboundQueue;
      attemptOutcome: { kind: 'failed'; class: 'crash' } | { kind: 'completed' };
      session: ReturnType<typeof sessionStub> | null;
      mapKey?: string;
    }): Promise<unknown>;
    finalizeRuntimeCrash(
      context: RuntimeTurnContext,
      queue: IOutboundQueue,
      session: ReturnType<typeof sessionStub> | null,
      mapKey?: string,
    ): void;
    awaitActiveFinalizations(): Promise<void>;
    beginRuntimeTurnEvidence(queue: IOutboundQueue, context: RuntimeTurnContext): void;
    consumeRuntimeTurnContinuationDeferral(context: RuntimeTurnContext): boolean;
    enqueuePerChatRuntimeTurn(mapKey: string, turn: QueuedTurn): boolean;
    terminalizePerChatTurnQueueForKill(mapKey: string): Promise<void>;
    finalizeRejectedRuntimeTurn(turn: QueuedTurn): void;
    awaitRejectedRuntimeTurnFinalizations(): Promise<void>;
    retryRuntimeTurnFinalizations(): Promise<{
      attempted: number;
      recovered: number;
      remaining: number;
      degradedScopes: number;
    }>;
  };
  sessionOwnership: Pick<
    SessionOwnershipRegistry,
    'claim' | 'transition' | 'advanceGeneration'
  >;
  managerIdFor(session: ReturnType<typeof sessionStub>): string;
  crashes: { record(scopeKey: string): number };
  handlePerChatCrash(
    mapKey: string,
    chatJid: string,
    info: {
      exitCode: number;
      signal: null;
      sessionId: string | null;
      dbRowId: number;
      generationIdentity: { managerId: string; generation: number };
    },
    expectedSession: ReturnType<typeof sessionStub>,
  ): void;
  beginPerChatRuntimeTurn(
    session: ReturnType<typeof sessionStub>,
    chatJid: string,
    mapKey: string,
    context: RuntimeTurnContext,
    scopeRef?: { value: string },
  ): { context: RuntimeTurnContext; promise: Promise<void> } | null;
  processTurn(turn: QueuedTurn): Promise<void>;
  finalizeRuntimeCrash(
    context: RuntimeTurnContext,
    queue: IOutboundQueue,
    session: ReturnType<typeof sessionStub> | null,
    mapKey?: string,
  ): void;
  maybeStartAutoCompact(session: ReturnType<typeof sessionStub> | null, mapKey?: string): void;
  turnQueue: {
    enqueue(turn: QueuedTurn): boolean;
    idle(): Promise<void>;
  };
  pendingSystemResults: {
    mark(scopeKey: string): void;
    consumeIfPending(scopeKey: string): boolean;
  };
  sendTurnNonShared(
    chatJid: string,
    text: string,
    actorJid: string,
    source: {
      sourceMessageId: string;
      receivedAtUnixSeconds: number;
      conversationKey: string;
      senderJid: string;
      senderName: string | null;
      contentType: 'text';
      isGroup: false;
    },
    inboundSeq: number,
  ): Promise<void>;
  sendTurnToSession(
    session: ReturnType<typeof sessionStub>,
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    beforeUserSend?: () => void,
    systemTurnLease?: undefined,
    dispatchAllowed?: () => boolean,
    runtimeContext?: RuntimeTurnContext,
    deliveryKind?: 'live' | 'queued' | 'recovery_replay',
  ): Promise<void>;
  ensureSessionAndQueueSync: ReturnType<typeof vi.fn>;
  handleEventWithContext(
    event: AgentEvent,
    queue: IOutboundQueue,
    session: ReturnType<typeof sessionStub>,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
    isSystemResult?: boolean,
  ): void;
  handleEvent(event: AgentEvent): void;
  sendTurnPerChat(
    chatJid: string,
    text: string,
    mapKey: string,
    actorJid: string,
    context: RuntimeTurnContext,
  ): Promise<void>;
  processPerChatTurn(scopeRef: { value: string }, turn: QueuedTurn): Promise<void>;
  normalizeAssistantTextForDelivery(
    event: Extract<AgentEvent, { type: 'assistant_text' }>,
    mapKey?: string,
  ): string | null;
}

export function context(
  scope: 'per_chat' | 'shared' | 'singleton',
  conversationKey: string,
  inboundSeq: number,
  logicalTurnId: string,
): RuntimeTurnContext {
  return createRuntimeTurnContext({
    identity: {
      scope,
      conversationKey,
      deliveryJid: `${conversationKey}@s.whatsapp.net`,
      inboundSeq,
      logicalTurnId,
      managerId: `manager-${scope}`,
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: 'manager-recovery',
      generation: 2,
    },
    replay: {
      sourceMessageId: `wamid-${logicalTurnId}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550190002@s.whatsapp.net',
      senderName: null,
      text: 'exact admitted turn',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: scope === 'per_chat' ? conversationKey : '__global__',
  });
}

export function durabilityMock() {
  return {
    markInboundFailed: vi.fn(),
    hasOutstandingTurnRecoveryForScope: vi.fn<(
      scope: 'per_chat' | 'shared' | 'singleton',
      conversationKey: string,
    ) => boolean>(() => false),
    getTurnRecoverySupervisorCounts: vi.fn(() => ({
      outstanding: 0,
      blockedUnsafe: 0,
      pending: 0,
      liveClaimed: 0,
      expiredClaimed: 0,
      exhausted: 0,
      quarantinedDelivery: 0,
      corruptLinks: 0,
      orphanTransfers: 0,
      echoConflicts: 0,
      openRecoveries: 0,
    })),
    getOutboundDeliverySnapshot: vi.fn<(opId: number, expected: {
      conversationKey: string;
      deliveryJid: string;
      sourceInboundSeq: number | null;
    }) => OutboundDeliverySnapshot | undefined>(
      (opId, expected) => ({ opId, ...expected, status: 'echoed' }),
    ),
    finalizeTurnTerminal: vi.fn<(_params: unknown) => FinalizeTurnTerminalResult>(() => ({
      applied: true,
      winnerMatchesRequest: true,
      recordId: 1,
      duplicateFinalizeCount: 0,
      replyGuaranteeDisarmed: true,
      effectiveReplyGuaranteeDisarmed: true,
    })),
  };
}

export function replyGuaranteeMock() {
  return {
    arm: vi.fn(),
    disarm: vi.fn(),
    notifyActivity: vi.fn(),
    isArmed: vi.fn(() => false),
    shutdown: vi.fn(),
  };
}

export function queueStub(chatJid: string): IOutboundQueue {
  return {
    targetChatJid: chatJid,
    enqueueText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    enqueueProgressUpdate: vi.fn(),
    setToolUpdateMode: vi.fn(),
    setToolUpdateRedirectJid: vi.fn(),
    setTextAggregateDelayMs: vi.fn(),
    indicateTyping: vi.fn(),
    enqueuePoll: vi.fn(async (fn) => { await fn(); }),
    hasPendingPoll: vi.fn(() => false),
    setPollPending: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    markLastTerminal: vi.fn(),
    setDurability: vi.fn(),
    endTurn: vi.fn(),
    beginTurnEvidence: vi.fn(),
    flushTurnEvidence: vi.fn(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    })),
  } as unknown as IOutboundQueue;
}

export function sessionStub() {
  return {
    clearTurnWatchdog: vi.fn(),
    completeProviderTurn: vi.fn(),
    tickWatchdog: vi.fn(),
    sendTurn: vi.fn(async (_input: unknown) => {}),
    spawnSession: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    getDbRowId: vi.fn(() => 41),
    getStatus: vi.fn<() => {
      active: boolean;
      sessionId: string | null;
      pid: number | null;
      turnInFlight?: boolean;
      durableFailureClosed?: boolean;
      durableFailureInconclusive?: boolean;
    }>(() => ({ active: true, sessionId: 'session-41', pid: 4100, turnInFlight: false })),
  };
}

export function messenger() {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

/**
 * Construct the integration runtime plus its private-state view. Options are
 * forwarded unchanged; the no-options arm calls the three-argument constructor
 * so the harness is call-shape-identical to the original inline sites.
 */
export function makeRuntimeState<TState extends RuntimeState = RuntimeState>(
  db: Database,
  options?: AgentRuntimeOptions,
): { runtime: AgentRuntime; state: TState } {
  const runtime =
    options === undefined
      ? new AgentRuntime(db, messenger() as never, 'terminal-integration')
      : new AgentRuntime(db, messenger() as never, 'terminal-integration', options);
  return { runtime, state: runtime as unknown as TState };
}
