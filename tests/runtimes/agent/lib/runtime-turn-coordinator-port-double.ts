// A test double for RuntimeTurnCoordinatorPort that the compiler actually checks.
//
// The doubles in the coordinator suites were each written inline and laundered
// through `as unknown as RuntimeTurnCoordinatorPort`, which defeats the
// structural check entirely: when the port gained a required member, `tsc` could
// not have flagged either of them. Nothing broke, because neither suite drives
// the code path that calls it — but that is luck, not a guarantee, and the next
// required member gets the same silence.
//
// The base below is annotated `satisfies RuntimeTurnCoordinatorPort`, the same
// idiom the production implementor uses, so a newly required member is a
// compile error HERE, in one place, instead of being silently absent in every
// test host. Members whose real types cannot be constructed in a unit test are
// individually cast and given a thrower, so an unexpected call fails loudly with
// the member's name rather than returning undefined and failing somewhere else.
import { vi } from 'vitest';

import type { RuntimeTurnCoordinatorPort } from '../../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import type { SessionManager } from '../../../../src/runtimes/agent/session.ts';
import type { IOutboundQueue } from '../../../../src/runtimes/agent/outbound-queue.ts';

/** Fails loudly, naming the member, instead of returning undefined. */
function unstubbed(member: string): never {
  throw new Error(`RuntimeTurnCoordinatorPort double: ${member} is not stubbed for this test`);
}

/**
 * A structurally complete port double. Override only what a case exercises.
 *
 * `overrides` is applied on top, so a case stays as short as the inline object
 * it replaces while the completeness check stays in force.
 */
export function coordinatorPortDouble(
  overrides: Partial<RuntimeTurnCoordinatorPort> = {},
): RuntimeTurnCoordinatorPort {
  const base = {
    durability: null,
    instanceName: 'port-double',
    sessionScope: 'per_chat',
    // Complex collaborators: their real types are not constructible here, so the
    // member is cast and left inert. The port-level check above is unaffected.
    runtimeTurnSupervisor: {
      canAccept: vi.fn(() => true),
      scopeKey: vi.fn(() => 'per_chat:port-double'),
    } as unknown as RuntimeTurnCoordinatorPort['runtimeTurnSupervisor'],
    sessionOwnership: {} as unknown as RuntimeTurnCoordinatorPort['sessionOwnership'],
    recoveryManagerId: 'port-double-manager',
    recoveryGeneration: 0,
    replyGuarantee: null,
    perChatInboundSeqQueue: new Map(),
    perChatRuntimeTurnContexts: new Map(),
    perChatRuntimeTurnCompletions: new Map(),
    perChatRuntimeTurnScopeRefs: new Map(),
    turnQueue: {} as unknown as RuntimeTurnCoordinatorPort['turnQueue'],
    replaceGlobalTurnQueue: (): void => unstubbed('replaceGlobalTurnQueue'),
    perChatTurnQueues: new Map(),
    perChatTurnQueueKeys: new WeakMap(),
    perChatExecActorQueue: new Map(),
    pendingTurnText: new Map(),
    pendingTurnActorJid: new Map(),
    perChatTurnSourceMessageId: new Map(),
    perChatTurnContentType: new Map(),
    perChatTurnText: new Map(),
    perChatTurnSuppressedReplySatisfaction: new Set(),
    perChatAssistantItemText: new Map(),
    perChatRouteMarkerHold: new Map(),
    chatQueues: new Map<string, IOutboundQueue>(),
    chatSessions: new Map<string, SessionManager>(),
    session: null,
    currentInboundSeq: undefined,
    currentRuntimeTurnContext: null,
    currentRuntimeTurnCompletion: null,
    currentTurnChatJid: null,
    currentTurnReplayText: null,
    currentTurnReplayActorJid: undefined,
    currentTurnInboundContentType: null,
    currentTurnAssistantText: '',
    currentTurnAssistantItemText: new Map<string, string>(),
    turnHadVisibleOutput: false,
    turnHadSuppressedReplySatisfaction: false,
    runtimeTurnAfterTerminal: new Map(),
    managerIdFor: (): string => unstubbed('managerIdFor'),
    // The member whose addition this file exists to catch.
    requireSessionToolScopeKey: (): string => unstubbed('requireSessionToolScopeKey'),
    getActiveQueue: (): IOutboundQueue | null => null,
    getQueueForChat: (): IOutboundQueue | null => null,
    sendTurnPerChat: (): Promise<void> => unstubbed('sendTurnPerChat'),
    deleteOwnedPerChatSession: (): boolean => unstubbed('deleteOwnedPerChatSession'),
    discardPerChatSessionForFallback: (): boolean => unstubbed('discardPerChatSessionForFallback'),
    discardSingletonSessionForFallback: (): boolean => unstubbed('discardSingletonSessionForFallback'),
    recreatePerChatSessionForFallback: (): void => unstubbed('recreatePerChatSessionForFallback'),
    recreateSingletonSessionForFallback: (): void => unstubbed('recreateSingletonSessionForFallback'),
    isReplayRouteCurrent: (): boolean => unstubbed('isReplayRouteCurrent'),
    bindActiveGlobalMcpConversation: (): void => unstubbed('bindActiveGlobalMcpConversation'),
    sendTurnToSession: (): Promise<void> => unstubbed('sendTurnToSession'),
    sendVoiceReply: (): Promise<void> => unstubbed('sendVoiceReply'),
  } satisfies RuntimeTurnCoordinatorPort;

  return { ...base, ...overrides };
}
