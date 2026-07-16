import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  handleGlobalRuntimeResult,
  handleScopedRuntimeResult,
  type RuntimeResultHandlerPort,
} from '../../../src/runtimes/agent/runtime-turn-result-handler.ts';

const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked,
  emitAlert: vi.fn(() => ({ status: 'durably_queued' })),
}));

function runtimeContext() {
  return createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550190077',
      deliveryJid: '15550190077@s.whatsapp.net',
      inboundSeq: 91,
      logicalTurnId: 'turn-escape-91',
      managerId: 'manager-escape',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: 'turn-escape-91-recovery',
      managerId: 'manager-escape-recovery',
      generation: 1,
    },
    replay: {
      sourceMessageId: 'wamid-escape-91',
      replaySafe: true,
      senderJid: '15550190077@s.whatsapp.net',
      senderName: null,
      text: 'hello',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '15550190077#session',
  });
}

function makeHost(overrides: { mapKey?: string } = {}) {
  const context = runtimeContext();
  const session = {
    clearTurnWatchdog: vi.fn(),
    completeProviderTurn: vi.fn(),
    shutdown: vi.fn(),
    getDbRowId: vi.fn(() => 5),
  };
  const runtimeTurnCoordinator = {
    runtimeTurnContext: vi.fn(() => context),
    attemptOutcomeForResult: vi.fn(() => ({ kind: 'completed' as const })),
    consumeRuntimeTurnContinuationDeferral: vi.fn(() => false),
    finalizeRuntimeTurnContext: vi.fn(async () => {
      throw new Error('boom: finalization pipeline threw before reaching the DB write');
    }),
    runtimeTurnScopeKey: vi.fn(() => 'per_chat:15550190077'),
    markRuntimeTurnDegraded: vi.fn(),
    rejectRuntimeTurnCompletion: vi.fn(),
    markRuntimeTurnReplayUnsafe: vi.fn(),
    appendRuntimeTurnAfterTerminalAction: vi.fn(),
    flushUnownedRuntimeResult: vi.fn(),
  };
  const queue = {
    targetChatJid: '15550190077@s.whatsapp.net',
    enqueueText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    endTurn: vi.fn(),
  } as unknown as IOutboundQueue;
  const host = {
    runtimeTurnCoordinator,
    db: {},
    durability: {},
    instanceName: 'escape-alert-test',
    shared: false,
    pendingPolls: { questions: new Map() },
    pendingSystemResults: { consumeIfPending: vi.fn(() => false) },
    workspaceSweeper: { touch: vi.fn() },
    postTurnGate: new Set<string>(),
    turnHadToolActivity: new Set<string>(),
    perChatRouteMarkerHold: new Map<string, string>(),
    pendingTurnText: new Map<string, string>(),
    pendingTurnActorJid: new Map<string, string | undefined>(),
    perChatTurnText: new Map<string, string>(),
    perChatAssistantItemText: new Map<string, Map<string, string>>(),
    perChatTurnContentType: new Map<string, string>(),
    perChatTurnSuppressedReplySatisfaction: new Set<string>(),
    currentTurnAssistantItemText: new Map<string, string>(),
    session,
    activeChatJid: queue.targetChatJid,
    currentInboundSeq: 91,
    currentTurnChatJid: queue.targetChatJid,
    currentTurnReplayText: null,
    currentTurnReplayActorJid: undefined,
    currentTurnRouteMarkerHold: null,
    currentTurnInboundContentType: null,
    currentTurnAssistantText: '',
    turnHadVisibleOutput: false,
    turnHadSuppressedReplySatisfaction: false,
    singleTurnHadToolActivity: false,
    isFallbackWindowActive: false,
    isSilentCompact: vi.fn(() => false),
    clearSilentCompact: vi.fn(),
    consumeCompactBoundary: vi.fn(() => false),
    finishAutoCompact: vi.fn(),
    recordAutoCompactSuccess: vi.fn(),
    recordAutoCompactNextTurnIfNeeded: vi.fn(),
    maybeStartAutoCompact: vi.fn(),
    flushRouteMarker: vi.fn(() => null),
    clearToolNames: vi.fn(),
    recordTurnCostUsd: vi.fn(),
    recordTurnCapabilitySuccess: vi.fn(),
    recordTurnCapabilityFailure: vi.fn(),
    recordFallbackTurnOutcome: vi.fn(),
    maybeArmFallbackAfterEmptyPrimaryTurn: vi.fn(() => false),
    enqueueAutoSwitchNotice: vi.fn(() => false),
    withHandoffPrefix: vi.fn((_chatJid: string, text: string) => text),
    flushPendingHandoffNotice: vi.fn(),
    activateProviderFallback: vi.fn(() => null),
    activateProviderFallbackAfterTerminalResult: vi.fn(() => null),
    scheduleFallbackReplay: vi.fn(() => false),
    notifyProviderFallbackActivated: vi.fn(),
    emitNoFallbackReauthNotice: vi.fn(),
    usageLimitNotice: vi.fn(() => 'usage limit notice'),
    kickDiagnosticBundle: vi.fn(),
  } as unknown as RuntimeResultHandlerPort;

  return { host, queue, session, mapKey: overrides.mapKey ?? '15550190077' };
}

describe('runtime turn finalization escape — visible failure (#1775)', () => {
  beforeEach(() => {
    emitAlertChecked.mockClear();
  });

  it('scoped: alerts ops when finalizeRuntimeTurnContext rejects, not just log.error', async () => {
    const { host, queue, session, mapKey } = makeHost();

    handleScopedRuntimeResult(host, {
      event: { type: 'result', text: null, inputTokens: 10, outputTokens: 2 },
      queue,
      session: session as never,
      conversationKey: '15550190077',
      inboundSeq: 91,
      mapKey,
      toolScopeKey: '15550190077#session',
      isSystemResult: false,
      extractUsageLimitResetTime: () => null,
    });

    // The .catch() runs on the microtask queue after handleScopedRuntimeResult returns.
    await vi.waitFor(() => {
      expect(emitAlertChecked).toHaveBeenCalledTimes(1);
    });
    const [instanceName, source] = emitAlertChecked.mock.calls[0] as unknown as [string, string, string, string, string?];
    expect(instanceName).toBe('escape-alert-test');
    expect(source).toBe('agent_turn_finalization_escaped');
    expect(session.completeProviderTurn).toHaveBeenCalledOnce();
  });

  it('global: alerts ops when finalizeRuntimeTurnContext rejects, not just log.error', async () => {
    const { host, queue, session } = makeHost();

    handleGlobalRuntimeResult(host, {
      event: { type: 'result', text: null, inputTokens: 10, outputTokens: 2 },
      queue,
      extractUsageLimitResetTime: () => null,
    });

    await vi.waitFor(() => {
      expect(emitAlertChecked).toHaveBeenCalledTimes(1);
    });
    const [instanceName, source] = emitAlertChecked.mock.calls[0] as unknown as [string, string, string, string, string?];
    expect(instanceName).toBe('escape-alert-test');
    expect(source).toBe('agent_turn_finalization_escaped');
    expect(session.completeProviderTurn).toHaveBeenCalledOnce();
  });
});
