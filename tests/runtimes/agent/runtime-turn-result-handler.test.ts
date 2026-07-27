/**
 * This suite pairs behavioral assertions with a static source invariant: the
 * redaction property must hold at every log site, including the ones a driven
 * classification never reaches. Reading production source is the only way to
 * cover those without an invasive harness per failure path — the same rationale
 * as logging-coverage.test.ts and runtime-structural-policy.test.ts.
 *
 * test-integrity: source-string-ok
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectNoRawSecret,
  expectPreviewRedacted,
  providerErrorText,
  secretFixtures,
} from '../../fixtures/redaction-fixtures.ts';

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
      receivedAtUnixSeconds: 1_780_000_000,
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
  it('releases only the provider request token attached by exact terminal admission', () => {
    const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });

    handleScopedRuntimeResult(harness.host, {
      event: {
        type: 'result',
        text: 'done',
        providerTurnOwnerToken: 41,
      },
      queue: harness.queue,
      session: harness.session as never,
      conversationKey: '15550190050',
      inboundSeq: 71,
      mapKey: '15550190050',
      toolScopeKey: '15550190050#session',
      isSystemResult: false,
      extractUsageLimitResetTime: () => null,
    });

    expect(harness.session.completeProviderTurn).toHaveBeenCalledWith(41);
  });

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
 * These lines pair `chatJid` with a preview of arbitrary provider output, so an
 * unsanitized preview publishes chat-linked secrets into the journal. Asserted on
 * the value the handler actually logs, so a regression fails here and not only in
 * the source scan below.
 */
describe('provider preview redaction in result logs', () => {
  const fixtures = secretFixtures();
  // Prefixed with a classifier token so the result routes down the same
  // classified suppression path the redaction fix touches; the shared fixture
  // body supplies one secret of every class the sanitizer masks. Total length
  // stays under the 300-char preview window, so the full body reaches the log.
  const TEXT = `API Error 429: rate limit exceeded\n${providerErrorText(fixtures)}`;

  afterEach(() => {
    logSink.length = 0;
  });

  for (const path of ['scoped', 'global'] as const) {
    it(`${path}: logs a sanitized textPreview, never a raw secret`, () => {
      const harness = makeHarness({ fallbackActivation: null, replayScheduled: false });

      driveResult(path, harness, TEXT);

      const entries = logSink.filter((entry) => typeof entry.obj['textPreview'] === 'string');
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        // Holds for EVERY preview: no secret of any class survives. Some previews
        // carry a short classified error summary rather than the full provider
        // text, so demanding a redaction marker in each would assert something
        // that is not the security property.
        expectNoRawSecret(String(entry.obj['textPreview']), fixtures);
        // The preview stays chat-attributable — a sanitized log is only useful if
        // it still says which conversation it came from.
        expect(entry.obj['chatJid']).toBe('15550190050@s.whatsapp.net');
      }

      // At least one preview is built from the full secret-bearing text, which is
      // what proves the sanitizer ran rather than the secret merely being absent.
      const full = entries
        .map((entry) => String(entry.obj['textPreview']))
        .find((preview) => preview.includes('invalid_request_error'));
      expect(full).toBeDefined();
      expectPreviewRedacted(full as string, fixtures);
    });
  }
});

describe('provider preview redaction — source invariant (all sites)', () => {
  // Both modules build provider-text previews for structured logs; the invariant
  // is a property of that CLASS, not of one file. Scoping it to the file an issue
  // happened to name is how seven identical sites in runtime.ts stayed unnoticed.
  const MODULES = ['runtime-turn-result-handler.ts', 'runtime.ts'] as const;

  for (const moduleName of MODULES) {
    const SOURCE = readFileSync(
      new URL(`../../../src/runtimes/agent/${moduleName}`, import.meta.url),
      'utf8',
    );

    it(`${moduleName}: every textPreview value is built by the canonical sanitizer`, () => {
      // Deliberately NOT conditioned on `.slice(` being present. An earlier version
      // was, and a mutation run proved it let a STRICTLY WORSE defect through:
      // `textPreview: event.text` logs the entire raw provider text unbounded and
      // contains no `.slice(`, so it passed the scan cleanly. The property is
      // "the value came from the sanitizer", not "the value was truncated".
      const assignments = SOURCE.match(/textPreview:[^,\n}]*/g) ?? [];
      expect(assignments.length).toBeGreaterThan(0);

      const unsanitized = assignments.filter((line) => !line.includes('providerPreview('));
      expect(unsanitized).toEqual([]);
    });

    it(`${moduleName}: any textPreview shorthand is bound to a sanitized local`, () => {
      // `{ chatJid, textPreview }` shorthand carries no expression on its own line,
      // so the assignment scan above cannot see it. Every `const textPreview = …`
      // binding must therefore itself come from the sanitizer.
      const bindings = SOURCE.match(/const textPreview =[^;]*/g) ?? [];
      const unsanitized = bindings.filter((line) => !line.includes('providerPreview('));
      expect(unsanitized).toEqual([]);
    });
  }
});
