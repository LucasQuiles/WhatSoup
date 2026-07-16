import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  handleGlobalRuntimeResult,
  handleScopedRuntimeResult,
  type ProviderFallbackActivation,
  type RuntimeResultHandlerPort,
} from '../../../src/runtimes/agent/runtime-turn-result-handler.ts';

type FailureReason = 'rate-limit' | 'model-unavailable';
type ResultPath = 'scoped' | 'global';

const CASES: ReadonlyArray<{
  reason: FailureReason;
  text: string;
  noticeFragment: string;
}> = [
  {
    reason: 'rate-limit',
    text: 'API Error 429: rate limit exceeded',
    noticeFragment: 'Primary model is rate limited',
  },
  {
    reason: 'model-unavailable',
    text: "There's an issue with the selected model (missing-model). It may not exist or you may not have access to it.",
    noticeFragment: 'Primary model is unavailable on this host',
  },
];

function activation(reason: FailureReason): ProviderFallbackActivation {
  return {
    primaryProvider: 'claude-cli',
    fallbackProvider: 'opencode-cli',
    fallbackModel: 'minimax/test-model',
    reason,
    resetAt: null,
    activeUntil: Date.now() + 60_000,
    extended: false,
    keyPresent: true,
    recoveryProbeRequired: true,
  };
}

function makeHarness(options: {
  fallbackActivation: ProviderFallbackActivation | null;
  replayScheduled: boolean;
}) {
  const timeline: string[] = [];
  const runtimeContext = createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550190050',
      deliveryJid: '15550190050@s.whatsapp.net',
      inboundSeq: 71,
      logicalTurnId: 'turn-result-handler',
      managerId: 'manager-result-handler',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: 'turn-result-handler-recovery',
      managerId: 'manager-result-handler-recovery',
      generation: 2,
    },
    replay: {
      sourceMessageId: 'wamid-result-handler',
      replaySafe: true,
      senderJid: '15550190050@s.whatsapp.net',
      senderName: null,
      text: 'retry this turn',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '15550190050#session',
  });
  const finalizeRuntimeTurnContext = vi.fn(async () => {
    timeline.push('finalize');
    return undefined;
  });
  const runtimeTurnCoordinator = {
    runtimeTurnContext: vi.fn(() => runtimeContext),
    attemptOutcomeForResult: vi.fn((event: { text: string | null }) => ({
      kind: 'failed' as const,
      class: event.text?.includes('429') ? 'rate-limit' as const : 'model-unavailable' as const,
    })),
    consumeRuntimeTurnContinuationDeferral: vi.fn(() => options.replayScheduled),
    finalizeRuntimeTurnContext,
    runtimeTurnScopeKey: vi.fn(() => 'per_chat:15550190050'),
    markRuntimeTurnDegraded: vi.fn(),
    rejectRuntimeTurnCompletion: vi.fn(),
    markRuntimeTurnReplayUnsafe: vi.fn(),
    appendRuntimeTurnAfterTerminalAction: vi.fn(),
    flushUnownedRuntimeResult: vi.fn(),
  };
  const queue = {
    targetChatJid: '15550190050@s.whatsapp.net',
    enqueueText: vi.fn((..._args: unknown[]) => {
      timeline.push('notice');
    }),
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    endTurn: vi.fn(),
  } as unknown as IOutboundQueue & {
    enqueueText: ReturnType<typeof vi.fn>;
    enqueueResultText: ReturnType<typeof vi.fn>;
  };
  const session = {
    clearTurnWatchdog: vi.fn(),
    completeProviderTurn: vi.fn(),
    shutdown: vi.fn(() => {
      timeline.push('shutdown');
    }),
    getDbRowId: vi.fn(() => null),
  };
  const notifyProviderFallbackActivated = vi.fn(() => {
    timeline.push('fallback-notice');
  });
  const host = {
    runtimeTurnCoordinator,
    db: {},
    durability: null,
    instanceName: 'result-handler-test',
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
    currentInboundSeq: 71,
    currentTurnChatJid: queue.targetChatJid,
    currentTurnReplayText: 'retry this turn',
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
    activateProviderFallback: vi.fn(() => options.fallbackActivation),
    activateProviderFallbackAfterTerminalResult: vi.fn(() => options.fallbackActivation),
    scheduleFallbackReplay: vi.fn(() => options.replayScheduled),
    notifyProviderFallbackActivated,
    emitNoFallbackReauthNotice: vi.fn(),
    usageLimitNotice: vi.fn(() => 'usage limit notice'),
    kickDiagnosticBundle: vi.fn(),
  } as unknown as RuntimeResultHandlerPort;

  return {
    host,
    queue,
    session,
    timeline,
    finalizeRuntimeTurnContext,
    notifyProviderFallbackActivated,
  };
}

function driveResult(
  path: ResultPath,
  harness: ReturnType<typeof makeHarness>,
  text: string,
): void {
  const event = { type: 'result' as const, text, isError: true };
  if (path === 'scoped') {
    handleScopedRuntimeResult(harness.host, {
      event,
      queue: harness.queue,
      session: harness.session as never,
      conversationKey: '15550190050',
      inboundSeq: 71,
      mapKey: '15550190050',
      toolScopeKey: '15550190050#session',
      isSystemResult: false,
      extractUsageLimitResetTime: () => null,
    });
    return;
  }
  handleGlobalRuntimeResult(harness.host, {
    event,
    queue: harness.queue,
    extractUsageLimitResetTime: () => null,
  });
}

describe('runtime result terminal provider notices', () => {
  afterEach(() => {
    delete process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'];
  });

  for (const path of ['scoped', 'global'] as const) {
    for (const registryDispatch of [false, true]) {
      for (const testCase of CASES) {
        it(`${path} ${testCase.reason} queues one notice before finalization when registry dispatch is ${registryDispatch ? 'on' : 'off'} and no fallback activates`, () => {
          if (registryDispatch) process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
          const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });

          driveResult(path, harness, testCase.text);

          expect(harness.queue.enqueueText).toHaveBeenCalledOnce();
          expect(harness.queue.enqueueText).toHaveBeenCalledWith(
            expect.stringContaining(testCase.noticeFragment),
          );
          expect(harness.queue.enqueueResultText).not.toHaveBeenCalled();
          expect(harness.session.completeProviderTurn).toHaveBeenCalledOnce();
          expect(harness.notifyProviderFallbackActivated).not.toHaveBeenCalled();
          expect(harness.session.shutdown).toHaveBeenCalledOnce();
          expect(harness.finalizeRuntimeTurnContext).toHaveBeenCalledOnce();
          expect(harness.timeline).toEqual(['notice', 'shutdown', 'finalize']);
        });
      }
    }
  }

  for (const registryDispatch of [false, true]) {
    for (const testCase of CASES) {
      it(`preserves activated ${testCase.reason} fallback behavior with registry dispatch ${registryDispatch ? 'on' : 'off'}`, () => {
        if (registryDispatch) process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
        const fallback = activation(testCase.reason);
        const harness = makeHarness({ fallbackActivation: fallback, replayScheduled: true });

        driveResult('scoped', harness, testCase.text);

        expect(harness.queue.enqueueText).not.toHaveBeenCalled();
        expect(harness.session.completeProviderTurn).toHaveBeenCalledOnce();
        expect(harness.notifyProviderFallbackActivated).toHaveBeenCalledOnce();
        expect(harness.notifyProviderFallbackActivated).toHaveBeenCalledWith(
          harness.queue,
          fallback,
          expect.objectContaining({ replayScheduled: true }),
        );
        expect(harness.session.shutdown).not.toHaveBeenCalled();
        expect(harness.finalizeRuntimeTurnContext).not.toHaveBeenCalled();
        expect(harness.timeline).toEqual(['fallback-notice']);
      });
    }
  }
});

describe('selected answer bookkeeping', () => {
  it('uses the scoped terminal result instead of discarded streamed narration for voice', () => {
    const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });
    const host = harness.host as unknown as {
      perChatTurnText: Map<string, string>;
      runtimeTurnCoordinator: {
        attemptOutcomeForResult: ReturnType<typeof vi.fn>;
      };
    };
    host.runtimeTurnCoordinator.attemptOutcomeForResult.mockReturnValue({ kind: 'completed' });
    host.perChatTurnText.set('15550190050', 'Discarded narration.');

    handleScopedRuntimeResult(harness.host, {
      event: { type: 'result', text: 'Selected final answer.', isError: false },
      queue: harness.queue,
      session: harness.session as never,
      conversationKey: '15550190050',
      inboundSeq: 71,
      mapKey: '15550190050',
      toolScopeKey: '15550190050#session',
      isSystemResult: false,
      extractUsageLimitResetTime: () => null,
    });

    expect(harness.finalizeRuntimeTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ responseText: 'Selected final answer.' }),
      }),
    );
  });

  it('uses the global terminal result instead of discarded streamed narration for voice', () => {
    const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });
    const host = harness.host as unknown as {
      currentTurnAssistantText: string;
      turnHadVisibleOutput: boolean;
      runtimeTurnCoordinator: {
        attemptOutcomeForResult: ReturnType<typeof vi.fn>;
      };
    };
    host.runtimeTurnCoordinator.attemptOutcomeForResult.mockReturnValue({ kind: 'completed' });
    host.currentTurnAssistantText = 'Discarded narration.';
    host.turnHadVisibleOutput = true;

    handleGlobalRuntimeResult(harness.host, {
      event: { type: 'result', text: 'Selected final answer.', isError: false },
      queue: harness.queue,
      extractUsageLimitResetTime: () => null,
    });

    expect(harness.finalizeRuntimeTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ responseText: 'Selected final answer.' }),
      }),
    );
  });

  it('omits discarded global narration from voice when an MCP tool owns the answer', () => {
    const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });
    const host = harness.host as unknown as {
      currentTurnAssistantText: string;
      singleTurnHadToolActivity: boolean;
      runtimeTurnCoordinator: {
        attemptOutcomeForResult: ReturnType<typeof vi.fn>;
      };
    };
    host.runtimeTurnCoordinator.attemptOutcomeForResult.mockReturnValue({ kind: 'completed' });
    host.currentTurnAssistantText = 'Discarded narration.';
    host.singleTurnHadToolActivity = true;
    (harness.queue as unknown as { hasToolReplyClaimed(): boolean }).hasToolReplyClaimed = vi.fn(() => true);

    handleGlobalRuntimeResult(harness.host, {
      event: { type: 'result', text: null, isError: false },
      queue: harness.queue,
      extractUsageLimitResetTime: () => null,
    });

    expect(harness.finalizeRuntimeTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ responseText: '' }),
      }),
    );
  });
});

describe('journaled result without runtime turn context (invariant-violation path)', () => {
  it('releases the per-chat replay latch when a journaled completed result has no runtime turn context', () => {
    const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });
    const host = harness.host as unknown as {
      durability: unknown;
      pendingTurnText: Map<string, string>;
      pendingTurnActorJid: Map<string, string | undefined>;
      runtimeTurnCoordinator: {
        runtimeTurnContext: ReturnType<typeof vi.fn>;
        attemptOutcomeForResult: ReturnType<typeof vi.fn>;
      };
    };
    // Durability is present and the result is journaled (inboundSeq defined),
    // but the immutable runtime turn context is missing — the invariant-violation
    // branch. The completed turn must still release the replay/eviction latch.
    host.durability = {};
    host.runtimeTurnCoordinator.runtimeTurnContext.mockReturnValue(null);
    host.runtimeTurnCoordinator.attemptOutcomeForResult.mockReturnValue({ kind: 'completed' });
    host.pendingTurnText.set('15550190050', 'queued user turn');
    host.pendingTurnActorJid.set('15550190050', 'user@s.whatsapp.net');

    handleScopedRuntimeResult(harness.host, {
      event: { type: 'result', text: 'done', isError: false },
      queue: harness.queue,
      session: harness.session as never,
      conversationKey: '15550190050',
      inboundSeq: 71,
      mapKey: '15550190050',
      toolScopeKey: '15550190050#session',
      isSystemResult: false,
      extractUsageLimitResetTime: () => null,
    });

    expect(host.pendingTurnText.has('15550190050')).toBe(false);
    expect(host.pendingTurnActorJid.has('15550190050')).toBe(false);
    expect(harness.session.completeProviderTurn).toHaveBeenCalledOnce();
  });

  it('preserves the replay latch on the invariant path when the turn did not complete cleanly', () => {
    const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });
    const host = harness.host as unknown as {
      durability: unknown;
      pendingTurnText: Map<string, string>;
      pendingTurnActorJid: Map<string, string | undefined>;
      runtimeTurnCoordinator: {
        runtimeTurnContext: ReturnType<typeof vi.fn>;
        attemptOutcomeForResult: ReturnType<typeof vi.fn>;
      };
    };
    host.durability = {};
    host.runtimeTurnCoordinator.runtimeTurnContext.mockReturnValue(null);
    host.runtimeTurnCoordinator.attemptOutcomeForResult.mockReturnValue({
      kind: 'failed',
      class: 'rate-limit',
    });
    host.pendingTurnText.set('15550190050', 'queued user turn');
    host.pendingTurnActorJid.set('15550190050', 'user@s.whatsapp.net');

    handleScopedRuntimeResult(harness.host, {
      event: { type: 'result', text: 'API Error 429: rate limit exceeded', isError: true },
      queue: harness.queue,
      session: harness.session as never,
      conversationKey: '15550190050',
      inboundSeq: 71,
      mapKey: '15550190050',
      toolScopeKey: '15550190050#session',
      isSystemResult: false,
      extractUsageLimitResetTime: () => null,
    });

    expect(host.pendingTurnText.get('15550190050')).toBe('queued user turn');
    expect(host.pendingTurnActorJid.get('15550190050')).toBe('user@s.whatsapp.net');
    expect(harness.session.completeProviderTurn).toHaveBeenCalledOnce();
  });
});
