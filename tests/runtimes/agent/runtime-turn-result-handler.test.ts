import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Capture structured log entries so the preview-redaction invariant can be
 * asserted on real handler behavior rather than on the source text. The module
 * under test only uses `createChildLogger`; the default export and the other
 * named exports are stubbed so any transitive importer in the graph still loads.
 */
const logSink = vi.hoisted(
  () => [] as Array<{ level: string; obj: Record<string, unknown>; msg: string }>,
);
vi.mock('../../../src/logger.ts', () => {
  const record = (level: string) => (obj: unknown, msg?: unknown) => {
    logSink.push({
      level,
      obj: (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>,
      msg: typeof msg === 'string' ? msg : '',
    });
  };
  const stub = (): Record<string, unknown> => ({
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    level: 'error',
    child: () => stub(),
  });
  return {
    default: stub(),
    createChildLogger: () => stub(),
    flushLogger: async () => {},
    errorLikeSerializers: {},
  };
});

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

/**
 * #2164 / #2208 — provider text reaching a structured log must be sanitized.
 *
 * These log lines pair `chatJid` with a preview of arbitrary provider output, so
 * an unsanitized preview publishes chat-linked secrets into the journal. The
 * canonical sanitizer already existed and was adopted by ten other modules; this
 * handler was the outlier. The invariant is asserted on the value the handler
 * actually logs, so re-introducing a raw `.slice()` fails here rather than only
 * failing a source scan.
 */
describe('provider preview redaction in result logs', () => {
  // Assembled at runtime, never written as a literal: a credential-SHAPED string
  // in committed test text trips the repo secret scanners, which cannot tell a
  // fixture from a real leak. Joining the parts keeps the shape the sanitizer
  // must match without ever putting that shape in the file.
  const SECRET = ['sk', 'ANT', 'FIXTURE', 'abc123def456'].join('-');
  const EMAIL = 'bob@example.com';
  const TEXT = `API Error 429: rate limit exceeded. Authorization: Bearer ${SECRET} for user ${EMAIL}`;

  afterEach(() => {
    logSink.length = 0;
  });

  for (const path of ['scoped', 'global'] as const) {
    it(`${path}: logs a sanitized textPreview, never the raw secret`, () => {
      const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });

      driveResult(path, harness, TEXT);

      const previews = logSink
        .map((entry) => entry.obj['textPreview'])
        .filter((value): value is string => typeof value === 'string');

      expect(previews.length).toBeGreaterThan(0);

      // The security invariant, asserted on EVERY preview: raw provider secrets
      // never reach a log field.
      for (const preview of previews) {
        expect(preview).not.toContain(SECRET);
        expect(preview).not.toContain(EMAIL);
      }

      // Not every preview is derived from the full provider text — some carry a
      // short classified error summary that contains no credential at all, so
      // requiring a redaction marker in each one would assert something that is
      // not the security property. Instead require that at least one preview
      // shows the markers, which proves the sanitizer actually ran on the
      // secret-bearing text rather than the secret merely being absent.
      expect(previews.some((preview) => preview.includes('Bearer [REDACTED]'))).toBe(true);
      expect(previews.some((preview) => preview.includes('[REDACTED_EMAIL]'))).toBe(true);
    });

    it(`${path}: still pairs the preview with chatJid so the log stays useful`, () => {
      const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });

      driveResult(path, harness, TEXT);

      const withPreview = logSink.filter((entry) => typeof entry.obj['textPreview'] === 'string');
      expect(withPreview.length).toBeGreaterThan(0);
      for (const entry of withPreview) {
        expect(entry.obj['chatJid']).toBe('15550190050@s.whatsapp.net');
      }
    });
  }
});

/**
 * Reachability-independent companion to the behavioral test above.
 *
 * The behavioral test can only assert the log sites its driven classification
 * actually reaches. A mutation run proved that gap: reverting ONE of the
 * sixteen sites to a raw `.slice()` left the behavioral test green, because
 * that particular branch is not exercised by the rate-limit path. This scan
 * closes the invariant over every site in the file, reached or not, which is
 * what makes "no raw provider text reaches a log preview" a property of the
 * module rather than of the paths a test happens to drive.
 */
describe('provider preview redaction — source invariant (all sites)', () => {
  const SOURCE = readFileSync(
    new URL('../../../src/runtimes/agent/runtime-turn-result-handler.ts', import.meta.url),
    'utf8',
  );

  it('routes every textPreview through the canonical sanitizer', () => {
    const previewAssignments = SOURCE.match(/textPreview[^\n]*/g) ?? [];
    expect(previewAssignments.length).toBeGreaterThan(0);

    const unsanitized = previewAssignments.filter(
      (line) => /\.slice\(/.test(line) && !line.includes('providerPreview('),
    );
    expect(unsanitized).toEqual([]);
  });

  // Deliberately NOT asserting the import line itself. That would pin a literal
  // source string — brittle against reformatting or a path move — and it proves
  // nothing the checks above do not: `providerPreview` cannot be called without
  // being imported, and typecheck enforces that. The invariant that carries the
  // weight is the one above, which is what kills a reverted-to-raw mutant.
});
