/**
 * Automatic provider fallback (claude-cli → opencode-cli) on usage limit.
 *
 * Covers the pure reset-time parser plus the AgentRuntime fallback state
 * machine: activation only when a fallback provider is configured,
 * effectiveProvider/effectiveModel flipping during the window, auto-revert
 * after the window elapses, window extension (idempotent activation), and
 * cleanup on shutdown. The state machine fields/methods are private, so the
 * tests reach them through bracket access on the constructed runtime.
 *
 * Timers are driven with vi.useFakeTimers (mirrors budget.test.ts) so the
 * 5-hour default revert window is exercised without real wall-clock delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

// ─── Mocks (declared before importing the runtime) ────────────────────────────

// Mutable config object — tests mutate fallback fields, then construct a runtime.
// The object is created inside the vi.mock factory (which is hoisted) and
// stashed on globalThis so the test body can mutate the same reference without
// the factory closing over a not-yet-initialized top-level variable.
vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    voiceReply: 'never',
    elevenlabs: {
      defaultVoiceId: 'v',
      defaultModel: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  };
  (globalThis as Record<string, unknown>)['__providerFallbackTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__providerFallbackTestConfig__'] as Record<string, unknown>;
}

// registerAllTools is a heavy import chain (MCP tools); a no-op satisfies the ctor.
vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

// Mock the credential lookup so the key-presence guard is deterministic and
// independent of the host machine's real keychain (the live fleet machine
// genuinely holds deepseek/minimax keys, which would contaminate "absent"
// assertions). Tests drive lookupCredentialMock per-case.
const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => null);
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

// Credential probe — stub to prevent real network calls from the fire-and-forget
// pre-flight in armFallbackWindow. This file does not assert probe outcomes;
// 'unknown' is the safe fail-open value that produces no credential alerts.
vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

// Unit tests must never spawn the real fallback binary; 'unknown' is the
// safe fail-open value (no alert, no version log).
const probeBinaryCommandMock = vi.fn<
  (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: unknown,
  ) => Promise<{ status: 'ok' | 'failed'; output: string }>
>(() => Promise.resolve({ status: 'failed', output: '' }));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
  probeBinaryCommand: (binary: string, args: string[], env: NodeJS.ProcessEnv, options?: unknown) =>
    probeBinaryCommandMock(binary, args, env, options),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import {
  AgentRuntime,
  extractUsageLimitResetTime,
} from '../../../src/runtimes/agent/runtime.ts';
import { Database } from '../../../src/core/database.ts';
import { ensureStandbyNoticeSchema } from '../../../src/runtimes/agent/standby-notice.ts';
import { ensureHandoffArtifactSchema, upsertHandoffArtifact } from '../../../src/runtimes/agent/handoff-artifact.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';
import { sanitizeProviderPreviewText } from '../../../src/lib/provider-preview-sanitizer.ts';
import { createProviderDataBoundary } from '../../../src/core/provider-data-boundary.ts';
import { PROVIDER_DATA_POLICY_VERSION } from '../../../src/core/provider-data-policy.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../src/runtimes/agent/providers/anthropic-api.ts';
import type {
  ProviderSession,
  ProviderSessionOptions,
} from '../../../src/runtimes/agent/providers/types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

interface RuntimeOverrides {
  agentProvider?: string;
  agentProviderConfig?: Record<string, unknown>;
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
  model?: string;
}

/** Construct a runtime after applying fallback config overrides. */
function makeRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = overrides.agentProvider ?? 'claude-cli';
  config['agentProviderConfig'] = overrides.agentProviderConfig;
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: overrides.model ?? 'claude-opus-4-8[1m]',
  });
}

function managedProviderSuccess(provider: 'openai-api' | 'anthropic-api'): Response {
  if (provider === 'openai-api') {
    return new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response([
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fallbackProviderOptions(
  provider: 'openai-api' | 'anthropic-api',
  mode: 'shadow' | 'enforce',
  suffix: string,
): ProviderSessionOptions {
  const model = provider === 'openai-api' ? 'gpt-test' : 'claude-test';
  const providerSessionId = `${provider}-${mode}-${suffix}`;
  const routePolicy = Object.freeze({
    provider,
    model,
    dataPolicy: 'restricted' as const,
    policyVersion: PROVIDER_DATA_POLICY_VERSION,
    policyState: 'classified' as const,
  });
  return {
    cwd: '/workspace/LAB/WhatSoup',
    systemPrompt: 'fallback boundary test',
    model,
    routePolicy,
    providerBoundaryMode: mode,
    providerSessionId,
    providerDataBoundary: createProviderDataBoundary({
      binding: {
        provider,
        model,
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId,
      },
      mode,
      routeSource: 'fallback',
    }),
    instanceName: 'fallback-boundary-test',
    onEvent: vi.fn(),
    onCrash: vi.fn(),
  };
}

function managedProvider(provider: 'openai-api' | 'anthropic-api'): ProviderSession {
  return provider === 'openai-api' ? new OpenAIApiProvider() : new AnthropicApiProvider();
}

/** Bracket-access view of the private fallback state machine. */
type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackPrimaryProbeTimer: ReturnType<typeof setTimeout> | null;
  revertTimer: ReturnType<typeof setTimeout> | null;
  effectiveProvider: string;
  effectiveModel: string | undefined;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error' | 'empty-output' | 'probe-unusable',
  ): {
    primaryProvider: string;
    fallbackProvider: string;
    fallbackModel: string | undefined;
    reason: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error' | 'empty-output' | 'probe-unusable';
    resetAt: Date | null;
    activeUntil: number;
    extended: boolean;
    keyPresent: boolean | null;
    recoveryProbeRequired: boolean;
  } | null;
  deactivateProviderFallback(reason: string): void;
  fallbackKeyPresent(provider: string | undefined, model: string | undefined): boolean | null;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  scheduleFallbackReplay(args: {
    activation: NonNullable<ReturnType<FallbackView['activateProviderFallback']>>;
    chatJid: string;
    mapKey?: string;
    oldSession: unknown;
    hadToolActivity?: boolean;
  }): boolean;
  replayTurnOnFallback(args: unknown): Promise<void>;
  getFallbackState(): {
    effectiveProvider: string;
    fallbackActiveUntil: number | null;
    fallbackReason: string | null;
    fallbackModel: string | null;
    fallbackResetAt: number | null;
    fallbackRecoveryProbeRequired: boolean;
    fallbackChainExhausted: boolean;
    failedEntryCount: number;
    turnErrorCounts: Record<string, number>;
  };
  recordTurnCapabilityFailure(isUserTurnResult: boolean, errorClass: string): void;
  agentFallbacks: Array<{ provider: string; model?: string }>;
  fallbackChain: {
    failedKeys: Set<string>;
    entryKey(entry: { provider: string; model?: string }): string;
  };
  kickDiagnosticBundle(wf: unknown, providerText: string): void;
  lastDiagnosticBundleAt: number;
  stashHandoffNotice(chatJid: string, message: string, now: number): boolean;
  withHandoffPrefix(chatJid: string, text: string): string;
  flushPendingHandoffNotice(queue: { targetChatJid: string; enqueueText(text: string): void }): void;
  formatContextLines(
    messages: ReadonlyArray<{ timestamp: number; senderName: string | null; senderJid: string; content: string | null }>,
    routePolicy?: {
      provider: string;
      model: string | undefined;
      dataPolicy: 'trusted' | 'restricted' | null;
      policyVersion: 'provider-data-policy-v1';
      policyState: 'classified' | 'missing' | 'unsupported';
    },
    hasCompatibleEnforcedBoundary?: boolean,
  ): string;
  buildHandoffSystemBlock(conversationKey: string, provider: string): (() => string | null) | undefined;
  // Background handoff distiller seams (extracted into HandoffDistillCoordinator).
  handoffDistill: {
    start(): void;
    timer: ReturnType<typeof setInterval> | null;
    runner: unknown | null;
  };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

// ─── extractUsageLimitResetTime ───────────────────────────────────────────────

describe('extractUsageLimitResetTime', () => {
  const now = new Date('2026-06-10T10:00:00');

  it('parses a 12-hour clock time later today ("resets at 3pm")', () => {
    const out = extractUsageLimitResetTime('Usage limit reached. Resets at 3pm.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(15);
    expect(out!.getMinutes()).toBe(0);
    expect(out!.getDate()).toBe(now.getDate());
  });

  it('parses a 24-hour clock time ("available at 15:00")', () => {
    const out = extractUsageLimitResetTime('Claude will be available at 15:00.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(15);
    expect(out!.getMinutes()).toBe(0);
  });

  it('parses minutes and am/pm ("try again at 9:30am")', () => {
    const out = extractUsageLimitResetTime('Try again at 9:30am tomorrow.', now);
    // 9:30am is before 10:00 "now", so it rolls forward to tomorrow.
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(9);
    expect(out!.getMinutes()).toBe(30);
    expect(out!.getDate()).toBe(now.getDate() + 1);
  });

  it('rolls a past clock time forward to tomorrow ("resets at 8am" when now is 10am)', () => {
    const out = extractUsageLimitResetTime('Usage cap reached. Resets at 8am.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(8);
    expect(out!.getDate()).toBe(now.getDate() + 1);
  });

  it('parses a future Unix epoch (seconds)', () => {
    const future = Math.floor(now.getTime() / 1000) + 3600; // +1h
    const out = extractUsageLimitResetTime(`Resets at ${future}.`, now);
    expect(out).not.toBeNull();
    expect(out!.getTime()).toBe(future * 1000);
  });

  it('returns null for messages with no reset time', () => {
    expect(extractUsageLimitResetTime('You are out of extra usage.', now)).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(extractUsageLimitResetTime('', now)).toBeNull();
    expect(extractUsageLimitResetTime(undefined as unknown as string, now)).toBeNull();
  });

  it('returns null for a past epoch (already elapsed)', () => {
    const past = Math.floor(now.getTime() / 1000) - 3600;
    expect(extractUsageLimitResetTime(`old ${past}`, now)).toBeNull();
  });

  it('prefers an explicit clock cue over an incidental long number (no epoch hijack)', () => {
    // The 10-digit order number must NOT be parsed as an epoch and override
    // the explicit "resets at 2pm" clock cue.
    const out = extractUsageLimitResetTime(
      'Order #5551234567 — usage limit reached, resets at 2pm.',
      now,
    );
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(14);
    expect(out!.getMinutes()).toBe(0);
    expect(out!.getDate()).toBe(now.getDate());
  });

  it('returns null for a bare long number with no reset cue', () => {
    // An incidental 10-digit quota figure is not a reset time.
    expect(
      extractUsageLimitResetTime('You have 5000000000 tokens of quota remaining.', now),
    ).toBeNull();
  });
});

// ─── Fallback state machine ───────────────────────────────────────────────────

describe('AgentRuntime — provider fallback state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does NOT activate when no fallback provider is configured', () => {
    const runtime = makeRuntime();
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('activates and flips effectiveProvider/effectiveModel during the window', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).effectiveModel).toBe('claude-opus-4-8[1m]');

    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2.7');
  });

  it('uses the default 5h window when no reset time is given', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    const before = Date.now();
    view(runtime).activateProviderFallback(null);
    const until = view(runtime).fallbackWindow.activeUntil!;
    expect(until - before).toBe(5 * 60 * 60 * 1000);
  });

  it('auto-reverts to the primary provider after the window elapses', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    // server-error is a window-elapse reason (NOT recovery-probe-gated, unlike
    // usage/rate/auth/empty/probe), so it reverts purely on window expiry.
    view(runtime).activateProviderFallback(null, 'server-error');
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');

    // Advance past the 5h default window.
    vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1);
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('reports the fallback chain exhausted once every configured entry has failed', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli', agentFallbackModel: 'minimax/MiniMax-M2.7' });
    const v = view(runtime);
    expect(v.getFallbackState().fallbackChainExhausted).toBe(false);
    expect(v.getFallbackState().failedEntryCount).toBe(0);

    for (const entry of v.agentFallbacks) {
      v.fallbackChain.failedKeys.add(v.fallbackChain.entryKey(entry));
    }
    expect(v.getFallbackState().fallbackChainExhausted).toBe(true);
    expect(v.getFallbackState().failedEntryCount).toBe(1);
  });

  it('a runtime with no configured fallbacks is never reported exhausted', () => {
    const v = view(makeRuntime({}));
    expect(v.agentFallbacks).toHaveLength(0);
    expect(v.getFallbackState().fallbackChainExhausted).toBe(false);
  });

  it('accumulates per-class turn-error counts for telemetry; ignores non-user turns', () => {
    const v = view(makeRuntime({}));
    v.recordTurnCapabilityFailure(true, 'rate-limit');
    v.recordTurnCapabilityFailure(true, 'rate-limit');
    v.recordTurnCapabilityFailure(true, 'auth-required');
    v.recordTurnCapabilityFailure(false, 'usage-limit'); // system turn — must not count
    expect(v.getFallbackState().turnErrorCounts).toEqual({ 'rate-limit': 2, 'auth-required': 1 });
  });

  it('formatContextLines renders "sender: content" with a media fallback (SSOT)', () => {
    const v = view(makeRuntime({}));
    const lines = v.formatContextLines([
      { timestamp: 0, senderName: 'Alice', senderJid: 'a@x', content: 'hello there' },
      { timestamp: 0, senderName: null, senderJid: 'bob@x', content: null },
    ]).split('\n');
    // Timestamp prefix is locale/TZ-dependent; assert the stable sender:content tail.
    expect(lines[0]).toContain('Alice: hello there');
    expect(lines[1]).toContain('bob@x: [media]');
    expect(lines).toHaveLength(2);
  });

  it('scrubs secret shapes from context only when injecting into a cross-provider fallback', () => {
    const v = view(makeRuntime({ agentFallbackProvider: 'opencode-cli' }));
    // A Bearer token embedded in chat content (the redactor catches the shape).
    const token = 'tokFAKE1234567890abcd';
    const msgs = [{ timestamp: 0, senderName: 'Lucas', senderJid: 'l@x', content: `use Bearer ${token} for the call` }];
    // No fallback active → same provider, no new exposure → verbatim.
    expect(v.formatContextLines(msgs)).toContain(token);
    // Fallback active → content crosses to a DIFFERENT provider → scrubbed.
    v.activateProviderFallback(null);
    const redacted = v.formatContextLines(msgs);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('for the call'); // surgical — conversation text preserved
    v.deactivateProviderFallback('test cleanup');
  });

  it('keeps Task 3 fallback sanitization by default and bypasses only for a compatible enforce boundary', () => {
    const v = view(makeRuntime({ agentFallbackProvider: 'openai-api' }));
    const token = 'tokFAKE1234567890abcd';
    const email = 'operator@example.com';
    const jid = '15551234567@s.whatsapp.net';
    const raw = `Authorization: Bearer ${token}; email ${email}; jid ${jid}`;
    const msgs = [{ timestamp: 0, senderName: 'Lucas', senderJid: 'l@x', content: raw }];
    v.activateProviderFallback(null);
    const restrictedRoute = {
      provider: 'openai-api',
      model: undefined,
      dataPolicy: 'restricted' as const,
      policyVersion: 'provider-data-policy-v1' as const,
      policyState: 'classified' as const,
    };
    const trustedRoute = { ...restrictedRoute, dataPolicy: 'trusted' as const };
    const expectedSanitized = sanitizeProviderPreviewText(raw);

    expect(v.formatContextLines(msgs, restrictedRoute)).toContain(expectedSanitized);
    expect(v.formatContextLines(msgs, restrictedRoute)).not.toContain(token);
    expect(v.formatContextLines(msgs, restrictedRoute)).not.toContain(email);
    expect(v.formatContextLines(msgs, restrictedRoute)).not.toContain(jid);
    expect(v.formatContextLines(msgs, restrictedRoute, false))
      .toBe(v.formatContextLines(msgs, restrictedRoute));
    expect(v.formatContextLines(msgs, restrictedRoute, true)).toContain(raw);
    expect(v.formatContextLines(msgs, trustedRoute, true)).toContain(expectedSanitized);
    v.deactivateProviderFallback('test cleanup');
  });

  it.each(['openai-api', 'anthropic-api'] as const)(
    'keeps fallback Bearer, email, and JID values out of downstream %s requests in shadow and enforce modes',
    async (providerName) => {
      const v = view(makeRuntime({ agentFallbackProvider: providerName }));
      const token = 'tokFAKE1234567890abcd';
      const email = 'operator@example.com';
      const jid = '15551234567@s.whatsapp.net';
      const raw = `Authorization: Bearer ${token}; email ${email}; jid ${jid}`;
      const routePolicy = {
        provider: providerName,
        model: providerName === 'openai-api' ? 'gpt-test' : 'claude-test',
        dataPolicy: 'restricted' as const,
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        policyState: 'classified' as const,
      };
      const message = [{ timestamp: 0, senderName: 'Lucas', senderJid: 'l@x', content: raw }];
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
        managedProviderSuccess(providerName));
      vi.stubGlobal('fetch', fetchMock);
      v.activateProviderFallback(null);

      const shadowContext = v.formatContextLines(message, routePolicy, false);
      const shadowProvider = managedProvider(providerName);
      await shadowProvider.initialize(fallbackProviderOptions(providerName, 'shadow', 'sanitized'));
      await shadowProvider.sendTurn({
        role: 'user',
        conversationKey: 'fallback-shadow',
        parts: [{ kind: 'text', text: shadowContext }],
      });
      const shadowBody = String(fetchMock.mock.calls[0]?.[1]?.body);
      expect(shadowBody).toContain(sanitizeProviderPreviewText(raw));
      expect(shadowBody).not.toContain(token);
      expect(shadowBody).not.toContain(email);
      expect(shadowBody).not.toContain(jid);

      fetchMock.mockClear();
      const enforceContext = v.formatContextLines(message, routePolicy, true);
      const secretProvider = managedProvider(providerName);
      await secretProvider.initialize(fallbackProviderOptions(providerName, 'enforce', 'secret'));
      await expect(secretProvider.sendTurn({
        role: 'user',
        conversationKey: 'fallback-enforce-secret',
        parts: [{ kind: 'text', text: enforceContext }],
      })).rejects.toMatchObject({ code: 'secret_detected' });
      expect(fetchMock).not.toHaveBeenCalled();

      const identifierRaw = `email ${email}; jid ${jid}`;
      const identifierContext = v.formatContextLines(
        [{ ...message[0]!, content: identifierRaw }],
        routePolicy,
        true,
      );
      const identifierProvider = managedProvider(providerName);
      await identifierProvider.initialize(fallbackProviderOptions(providerName, 'enforce', 'identifiers'));
      await identifierProvider.sendTurn({
        role: 'user',
        conversationKey: 'fallback-enforce-identifiers',
        parts: [{ kind: 'text', text: identifierContext }],
      });
      const enforceBody = String(fetchMock.mock.calls[0]?.[1]?.body);
      expect(enforceBody).not.toContain(email);
      expect(enforceBody).not.toContain(jid);
      expect(enforceBody).toContain('WSA1:email:');
      expect(enforceBody).toContain('WSA1:whatsapp_id:');
      v.deactivateProviderFallback('test cleanup');
    },
  );

  it('throttles the diagnostic bundle so a fallback storm cannot fan out probes', () => {
    const v = view(makeRuntime({ agentFallbackProvider: 'opencode-cli' }));
    // Simulate a very recent prior kick: a second kick within the window must be
    // throttled — it returns before building or spawning any probe, leaving the
    // timestamp unchanged.
    const recent = Date.now();
    v.lastDiagnosticBundleAt = recent;
    v.kickDiagnosticBundle({}, 'usage limit reached');
    expect(v.lastDiagnosticBundleAt).toBe(recent);
  });

  it.each(['auth-required', 'empty-output', 'probe-unusable'] as const)(
    'keeps %s fallback armed until a primary recovery probe succeeds',
    async (reason) => {
      const runtime = makeRuntime({
        agentFallbackProvider: 'opencode-cli',
        agentFallbackModel: 'minimax/MiniMax-M2.7',
      });
      const v = view(runtime);
      v.probePrimaryProviderRecovered = vi.fn(() => false);

      v.activateProviderFallback(null, reason);
      expect(v.effectiveProvider).toBe('opencode-cli');
      expect(v.getFallbackState().fallbackRecoveryProbeRequired).toBe(true);

      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000 + 1);
      expect(v.effectiveProvider).toBe('opencode-cli');
      expect(v.fallbackWindow.activeUntil).not.toBeNull();

      v.probePrimaryProviderRecovered = vi.fn(() => true);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(v.fallbackWindow.activeUntil).toBeNull();
      expect(v.effectiveProvider).toBe('claude-cli');
    },
  );

  // Recovery gap regression: a usage/rate-limit fallback must ALSO re-probe the
  // primary and revert as soon as it recovers, instead of blind-waiting for the
  // (often mis-parsed) reset window to elapse. Mirrors the auth-required case.
  it.each(['usage-limit', 'rate-limit'] as const)(
    'keeps %s fallback armed until a primary recovery probe succeeds',
    async (reason) => {
      const runtime = makeRuntime({
        agentFallbackProvider: 'opencode-cli',
        agentFallbackModel: 'minimax/MiniMax-M2.7',
      });
      const v = view(runtime);
      v.probePrimaryProviderRecovered = vi.fn(() => false);

      v.activateProviderFallback(null, reason);
      expect(v.effectiveProvider).toBe('opencode-cli');
      expect(v.getFallbackState().fallbackRecoveryProbeRequired).toBe(true);

      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000 + 1);
      expect(v.effectiveProvider).toBe('opencode-cli');
      expect(v.fallbackWindow.activeUntil).not.toBeNull();

      v.probePrimaryProviderRecovered = vi.fn(() => true);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(v.fallbackWindow.activeUntil).toBeNull();
      expect(v.effectiveProvider).toBe('claude-cli');
    },
  );

  it('schedules replay of the interrupted turn only when fallback is newly armed and usable', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const v = view(runtime);
    lookupCredentialMock.mockImplementation((svc) => (svc === 'minimax' ? 'mm-key' : null));
    const activation = v.activateProviderFallback(null, 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.pendingTurnActorJid.set('chat-key', 'sender@s.whatsapp.net');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(true);
    expect(v.replayTurnOnFallback).toHaveBeenCalledWith({
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      replayText: 'please continue the task',
      actorJid: 'sender@s.whatsapp.net',
      oldSession: null,
    });

    const extended = v.activateProviderFallback(null, 'usage-limit')!;
    expect(extended.extended).toBe(true);
    expect(v.scheduleFallbackReplay({
      activation: extended,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);
    expect(v.scheduleFallbackReplay({
      activation: { ...activation, keyPresent: false },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);

    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
      hadToolActivity: true,
    })).toBe(false);
  });

  it('clamps an immediate reset time to the minimum window', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    // resetAt in the past → clamped to now + MIN (1 minute).
    view(runtime).activateProviderFallback(new Date(Date.now() - 1000));
    const until = view(runtime).fallbackWindow.activeUntil!;
    expect(until - Date.now()).toBe(60 * 1000);
  });

  it('clamps an absurdly distant reset time to the maximum window', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(new Date(Date.now() + 999 * 60 * 60 * 1000));
    const until = view(runtime).fallbackWindow.activeUntil!;
    expect(until - Date.now()).toBe(24 * 60 * 60 * 1000);
  });

  it('extends the window to the later of the two on re-activation (idempotent)', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000)); // +1h
    const firstUntil = view(runtime).fallbackWindow.activeUntil!;
    // A second activation with a shorter window must not shorten the active one.
    view(runtime).activateProviderFallback(new Date(Date.now() + 30 * 60 * 1000)); // +30m
    expect(view(runtime).fallbackWindow.activeUntil).toBe(firstUntil);
    // A longer one extends it.
    view(runtime).activateProviderFallback(new Date(Date.now() + 3 * 60 * 60 * 1000)); // +3h
    expect(view(runtime).fallbackWindow.activeUntil!).toBeGreaterThan(firstUntil);
  });

  it('deactivate clears state and timer immediately', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).revertTimer).not.toBeNull();
    view(runtime).deactivateProviderFallback('manual');
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).revertTimer).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('shutdown clears the revert timer and fallback window', async () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).not.toBeNull();
    await runtime.shutdown();
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).revertTimer).toBeNull();
  });
});

// ─── Key-presence guard at activation ────────────────────────────────────────

describe('AgentRuntime — fallback key-presence guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a present key for opencode-cli/minimax (service from model prefix)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'minimax' ? 'mm-key' : null));
    const present = view(runtime).fallbackKeyPresent('opencode-cli', 'minimax/MiniMax-M2.7');
    expect(present).toBe(true);
    expect(lookupCredentialMock).toHaveBeenCalledWith('minimax');
  });

  it('reports an absent key for opencode-cli/minimax when the keyring has none', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockReturnValue(null);
    const present = view(runtime).fallbackKeyPresent('opencode-cli', 'minimax/MiniMax-M2.7');
    expect(present).toBe(false);
  });

  it('maps openai-api to the openai service', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'openai-api' });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'openai' ? 'oa-key' : null));
    const present = view(runtime).fallbackKeyPresent('openai-api', 'gpt-5');
    expect(present).toBe(true);
    expect(lookupCredentialMock).toHaveBeenCalledWith('openai');
  });

  it('uses providerConfig.apiKeyService for same-provider API fallback key presence', () => {
    const runtime = makeRuntime({
      agentProvider: 'openai-api',
      agentProviderConfig: { apiKeyService: 'tenant-openai' },
      agentFallbackProvider: 'openai-api',
      agentFallbackModel: 'gpt-4o-mini',
    });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'tenant-openai' ? 'tenant-key' : null));
    const present = view(runtime).fallbackKeyPresent('openai-api', 'gpt-4o-mini');
    expect(present).toBe(true);
    expect(lookupCredentialMock).toHaveBeenCalledWith('tenant-openai');
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('openai');
  });

  it('maps anthropic-api to the anthropic service', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'anthropic-api' });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'anthropic' ? 'anthropic-key' : null));
    const present = view(runtime).fallbackKeyPresent('anthropic-api', 'claude-sonnet-4-6');
    expect(present).toBe(true);
    expect(lookupCredentialMock).toHaveBeenCalledWith('anthropic');
  });

  it('returns null (not-applicable) for native-auth CLI providers', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'claude-cli' });
    for (const p of ['claude-cli', 'codex-cli', 'gemini-cli']) {
      expect(view(runtime).fallbackKeyPresent(p, undefined)).toBeNull();
    }
    expect(lookupCredentialMock).not.toHaveBeenCalled();
  });

  it('does NOT block activation when the fallback key is absent (warn-only)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockReturnValue(null);
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
  });

  it('activates normally when the fallback key is present', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'minimax' ? 'mm-key' : null));
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
  });
});

// ─── Primary recovery probe validity ────────────────────────────────────────

describe('AgentRuntime — primary recovery probe validity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
    probeBinaryCommandMock.mockClear();
    probeBinaryCommandMock.mockResolvedValue({ status: 'failed', output: '' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ['openai-api', 'openai', 'gpt-5.2', 'https://api.openai.com/v1/chat/completions'],
    ['anthropic-api', 'anthropic', 'claude-sonnet-4-6', 'https://api.anthropic.com/v1/messages'],
  ])(
    'does not mark %s recovered from key presence when the live API probe rejects the credential',
    async (provider, service, model, expectedUrl) => {
      lookupCredentialMock.mockImplementation((svc) => (svc === service ? 'present-but-invalid' : null));
      const fetchMock = vi.fn(async () => ({
        status: 401,
        ok: false,
        json: vi.fn(async () => ({ data: [] })),
        text: vi.fn(async () => 'Invalid authentication credentials'),
      }));
      vi.stubGlobal('fetch', fetchMock);

      const runtime = makeRuntime({
        agentProvider: provider,
        agentProviderConfig: { apiKeyService: service },
        model,
        agentFallbackProvider: 'opencode-cli',
        agentFallbackModel: 'minimax/MiniMax-M2.7',
      });

      // A present-but-invalid credential must NOT count as recovery: the probe
      // sends a real minimal-generation turn and a 401 keeps the primary down.
      await expect(view(runtime).probePrimaryProviderRecovered()).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: 'POST',
          headers: expect.any(Object),
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );

  it('does not mark opencode-cli recovered from model-prefix key presence when the live CLI probe fails auth', async () => {
    lookupCredentialMock.mockImplementation((svc) => (svc === 'openai' ? 'present-but-invalid' : null));
    probeBinaryCommandMock.mockResolvedValue({
      status: 'failed',
      output: 'Error: invalid_api_key',
    });
    const runtime = makeRuntime({
      agentProvider: 'opencode-cli',
      model: 'openai/gpt-5.2',
      agentFallbackProvider: 'claude-cli',
    });

    await expect(view(runtime).probePrimaryProviderRecovered()).resolves.toBe(false);
    expect(probeBinaryCommandMock).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--pure', '-m', 'openai/gpt-5.2', 'Reply with OK only.'],
      expect.objectContaining({ OPENAI_API_KEY: 'present-but-invalid' }),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });
});

// ─── assistant_text vs result asymmetry ──────────────────────────────────────

/** IOutboundQueue stub covering all members the result paths touch. */
function makeFakeQueue() {
  return {
    targetChatJid: 'fake@s.whatsapp.net',
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueResultText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    markLastTerminal: vi.fn(),
    flush: vi.fn(async () => {}),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    indicateTyping: vi.fn(),
    endTurn: vi.fn(),
  };
}

function makeEventSession() {
  return {
    clearTurnWatchdog: vi.fn(),
    completeProviderTurn: vi.fn(),
    getDbRowId: vi.fn(() => null),
    getProviderId: vi.fn(() => 'claude-cli'),
    getStatus: vi.fn(() => ({ active: true })),
    shutdown: vi.fn(async () => {}),
    tickWatchdog: vi.fn(),
    trackToolStart: vi.fn(),
    trackToolEnd: vi.fn(),
  };
}

type EventDriveView = {
  fallbackWindow: { activeUntil: number | null };
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
  ): void;
};

function driveView(runtime: AgentRuntime): EventDriveView {
  return runtime as unknown as EventDriveView;
}

/** Extended drive view that exposes the full 8-arg handleEventWithContext
 *  signature plus the process-local fallback telemetry counters. */
type FullEventDriveView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackTurnsServed: number;
  fallbackTurnsEmpty: number;
  lastFallbackTurnAt: number | null;
  turnHadVisibleOutput: boolean;
  queue: unknown;
  session: unknown;
  sessionEventToolScopes: WeakMap<object, string>;
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
    isSystemResult?: boolean,
  ): void;
  handleEvent(sourceSession: object, event: unknown): void;
  activateProviderFallback(resetAt: Date | null): void;
  managerIdFor(session: object): string;
  publishLegacyProviderTurn(session: object, scopeKey: string, routeChatJid: string): unknown;
};

function fullView(runtime: AgentRuntime): FullEventDriveView {
  return runtime as unknown as FullEventDriveView;
}

describe('AgentRuntime — usage-limit assistant_text/result asymmetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Resets at 3pm.';

  it('does NOT activate fallback on a usage-limit assistant_text event', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'assistant_text', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('DOES activate fallback on a usage-limit result event (the deferred site)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2.7');
  });

  it('does not silently replay a turn after tool activity started', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const v = view(runtime);
    v.pendingTurnText.set('chat-key', 'change the customer record');
    v.replayTurnOnFallback = vi.fn(async () => {});
    const queue = makeFakeQueue();

    fullView(runtime).handleEventWithContext(
      { type: 'tool_use', toolId: 'tool-1', toolName: 'whatsoup_add_or_edit_contact', toolInput: {} },
      queue,
      null,
      'conversation',
      123,
      'chat-key',
      'tool-scope',
      false,
    );
    fullView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      'conversation',
      123,
      'chat-key',
      'tool-scope',
      false,
    );

    expect(v.replayTurnOnFallback).not.toHaveBeenCalled();
    const blockedNotice = queue.enqueueText.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(blockedNotice).toContain(
      'The first attempt already started an action, so I will not replay it automatically. Please confirm or resend the next step.',
    );
    // The blocked directive is the SOLE resend instruction — the template's
    // generic "Please resend your last message." continuation is suppressed so
    // the user does not see two conflicting resend prompts.
    expect(blockedNotice).not.toContain('Please resend your last message.');
  });

  it('assistant_text then result: fallback stays null until the result fires', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'assistant_text', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackWindow.activeUntil).toBeNull();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
  });
});

// ─── Usage-limit user notice ──────────────────────────────────────────────────

describe('usage-limit user notice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Your limit will reset at 3pm.';

  it('enqueues a switch notice when a fallback provider is configured (per-chat path)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    const v = view(runtime);
    v.pendingTurnText.set('notice-key', 'continue this request');
    v.replayTurnOnFallback = vi.fn(async () => {});
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      undefined,
      undefined,
      'notice-key',
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('Primary model hit a usage/quota limit'),
      'lifecycle',
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('Switching to OpenCode / minimax/minimax-m2'),
      'lifecycle',
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining("I'll continue here."),
      'lifecycle',
    );
  });

  it('enqueues a plain limit notice naming the operator remedy when no fallback is configured', () => {
    const runtime = makeRuntime({});
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    // A per-tier usage cap is not cleared by waiting — the notice names the
    // operator remedy (add credits / switch model) rather than telling the user
    // to try again after the limit resets.
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('add credits or switch my model'),
    );
    expect(queue.enqueueText).not.toHaveBeenCalledWith(
      expect.stringContaining('try again after the limit resets'),
    );
  });

  it('enqueues the notice on the single/shared path too', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    const queue = makeFakeQueue();
    const session = makeEventSession();
    const state = fullView(runtime);
    state.queue = queue;
    state.session = session;
    state.managerIdFor(session);
    state.sessionEventToolScopes.set(session, '__global__');
    state.publishLegacyProviderTurn(session, '__global__', queue.targetChatJid);
    state.handleEvent(
      session,
      { type: 'result', text: USAGE_LIMIT_TEXT },
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('Primary model hit a usage/quota limit'),
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('Switching to OpenCode / minimax/minimax-m2'),
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('Please resend your last message.'),
    );
  });
});

// ─── Persistence hooks ────────────────────────────────────────────────────────

type PersistenceView = {
  fallbackWindow: { activeUntil: number | null };
  effectiveProvider: string;
  activateProviderFallback(resetAt: Date | null): void;
  deactivateProviderFallback(reason: string): void;
  restorePersistedFallbackWindow(): void;
};

function persistView(runtime: AgentRuntime): PersistenceView {
  return runtime as unknown as PersistenceView;
}

describe('AgentRuntime — fallback persistence hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('persists the window on activation and clears it on deactivation', () => {
    // ensureFallbackStateSchema spy omitted — not called by activate/deactivate.
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).activateProviderFallback(null);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'usage-limit' }),
    );

    persistView(runtime).deactivateProviderFallback('test');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('restores a persisted future window, preserves original activatedAt, and auto-reverts', () => {
    // Verify armFallbackWindow re-saves with the original activatedAt (not Date.now())
    // so the persisted record retains provenance across restarts.
    const now = Date.now();
    const activeUntil = now + 60 * 60_000;
    const originalActivatedAt = now - 1000;
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil,
      activatedAt: originalActivatedAt,
      reason: 'server-error',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('opencode-cli');

    // The re-save must carry the original activatedAt and the original reason
    // (not 'restored' — the restore event is captured in the log line, not
    // the persisted record).
    expect(saveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        activatedAt: originalActivatedAt,
        reason: 'server-error',
      }),
    );

    vi.advanceTimersByTime(61 * 60_000);
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('discards a stale persisted window (past expiry) without re-arming', () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: now - 1000,
      activatedAt: now - 10_000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('discards a persisted window when no fallback provider is configured', () => {
    // Covers the branch where agentFallbackProvider is undefined at restart —
    // the stale row must be cleared and the runtime must remain on the primary.
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    // No agentFallbackProvider configured.
    const runtime = makeRuntime({});

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('clears a corrupt persisted row that fails load validation', () => {
    // loadFallbackState returns null for both "no row" and "bad-typed row" (SQLite
    // affinity allows e.g. TEXT in an INTEGER column). On the null path the row must
    // be cleared so corruption does not linger across restarts — consistent with the
    // stale-row and no-fallback-provider treatments.
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue(null);
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('a throwing loadFallbackState never crashes restore', () => {
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockImplementation(() => {
      throw new Error('db exploded');
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    expect(() => persistView(runtime).restorePersistedFallbackWindow()).not.toThrow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('clamps a persisted window that exceeds MAX_FALLBACK_WINDOW_MS on restore', () => {
    // A clock-skew or tampered row could carry activeUntil = now + 72h, which
    // exceeds MAX (24h). Restore must clamp it so the in-memory window stays
    // within the expected range.
    const now = Date.now();
    const farFuture = now + 72 * 60 * 60 * 1000; // 72 hours
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: farFuture,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).restorePersistedFallbackWindow();

    // The runtime must be on fallback.
    expect(persistView(runtime).effectiveProvider).toBe('opencode-cli');

    // The re-save must carry activeUntil <= now + MAX_FALLBACK_WINDOW_MS (24h).
    const MAX = 24 * 60 * 60 * 1000;
    expect(saveSpy).toHaveBeenCalled();
    const savedState = saveSpy.mock.calls[0];
    if (!savedState) throw new Error('saveFallbackState was not called');
    expect(savedState[1].activeUntil).toBeLessThanOrEqual(now + MAX);
  });

  it('preserves the original activatedAt when the window is extended by a second activation', () => {
    // When a second activateProviderFallback fires while already active, the
    // first-engagement time must survive in the persisted row — only the window
    // end-time may advance.
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // First activation — record the activatedAt it persists.
    persistView(runtime).activateProviderFallback(null);
    const firstCall = saveSpy.mock.calls[0];
    if (!firstCall) throw new Error('saveFallbackState was not called on first activation');
    const originalActivatedAt = firstCall[1].activatedAt;
    const firstActiveUntil = firstCall[1].activeUntil;

    // Advance 1 hour so Date.now() has moved; a naive re-activation would
    // stamp a fresh activatedAt. Request a window that extends past the first
    // (now+1h + 20h = now+21h, which is beyond the initial now+5h).
    vi.advanceTimersByTime(60 * 60 * 1000);
    persistView(runtime).activateProviderFallback(new Date(Date.now() + 20 * 60 * 60 * 1000));

    const secondCall = saveSpy.mock.calls[1];
    if (!secondCall) throw new Error('saveFallbackState was not called on second activation');
    expect(secondCall[1].activatedAt).toBe(originalActivatedAt);
    expect(secondCall[1].activeUntil).toBeGreaterThan(firstActiveUntil);
  });
});

// ─── Custom-endpoint providerConfig scoping for sessions ─────────────────────
// The custom-endpoint fields (baseUrl/apiKeyService) belong to the PRIMARY
// provider+model: an opencode session serving a fallback entry must not
// inherit them, or the custom-endpoint argv contract would suppress the
// entry's `-m <model>` and re-route the turn to the primary's endpoint block
// (or opencode's default model when no block was written). Other
// providerConfig keys (budget, …) keep applying to every session, and
// managed-loop API fallback sessions keep today's full inheritance.

describe('createSessionManager — custom-endpoint providerConfig scoping', () => {
  type SessionView = { providerConfig: Record<string, unknown> | undefined };
  type RuntimeWithFactory = {
    createSessionManager(opts: {
      chatJid: string;
      cwd: string | undefined;
      onEvent: () => void;
      onCrash: () => void;
      notifyUser: () => void;
    }): unknown;
  };

  function buildSession(runtime: AgentRuntime): SessionView {
    return (runtime as unknown as RuntimeWithFactory).createSessionManager({
      chatJid: 'scope-test@s.whatsapp.net',
      cwd: undefined,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      notifyUser: vi.fn(),
    }) as unknown as SessionView;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    lookupCredentialMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the full providerConfig (baseUrl + apiKeyService) to primary opencode sessions', () => {
    const runtime = makeRuntime({
      agentProvider: 'opencode-cli',
      agentProviderConfig: {
        baseUrl: 'https://api.cloud.example/v1',
        apiKeyService: 'minimax',
        budget: { requestsPerMinute: 10 },
      },
      model: 'MiniMax-M2',
    });
    const session = buildSession(runtime);
    expect(session.providerConfig).toEqual({
      baseUrl: 'https://api.cloud.example/v1',
      apiKeyService: 'minimax',
      budget: { requestsPerMinute: 10 },
    });
  });

  it('strips the custom-endpoint fields but keeps the rest for an opencode session serving a fallback entry', () => {
    const runtime = makeRuntime({
      agentProvider: 'openai-api',
      agentProviderConfig: {
        baseUrl: 'https://api.openai.example/v1',
        apiKeyService: 'openai',
        budget: { requestsPerMinute: 10 },
      },
      model: 'gpt-5.2',
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
    });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');

    const session = buildSession(runtime);
    expect(session.providerConfig).toEqual({ budget: { requestsPerMinute: 10 } });

    view(runtime).deactivateProviderFallback('test cleanup');
  });

  it('keeps the full providerConfig for a managed API fallback session (existing inheritance pinned)', () => {
    const runtime = makeRuntime({
      agentProvider: 'openai-api',
      agentProviderConfig: {
        baseUrl: 'https://api.openai.example/v1',
        apiKeyService: 'deepseek',
      },
      model: 'gpt-5.2',
      agentFallbackProvider: 'anthropic-api',
      agentFallbackModel: 'claude-opus-4-8[1m]',
    });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).effectiveProvider).toBe('anthropic-api');

    const session = buildSession(runtime);
    expect(session.providerConfig).toEqual({
      baseUrl: 'https://api.openai.example/v1',
      apiKeyService: 'deepseek',
    });

    view(runtime).deactivateProviderFallback('test cleanup');
  });
});

describe('one-message handoff collapse (real db)', () => {
  function makeRealDbRuntime(): { runtime: AgentRuntime; db: Database } {
    const config = mockConfigRef();
    config['agentProvider'] = 'claude-cli';
    config['agentProviderConfig'] = undefined;
    config['agentFallbackProvider'] = 'opencode-cli';
    config['agentFallbackModel'] = undefined;
    const db = new Database(':memory:');
    db.open();
    // start() ensures this schema in production; mirror it here without the rest
    // of start()'s heavy setup.
    ensureStandbyNoticeSchema(db);
    const runtime = new AgentRuntime(db, makeMessenger(), 'test', { model: 'claude-opus-4-8[1m]' });
    return { runtime, db };
  }

  function withFlag(value: '1' | undefined, fn: () => void): void {
    const prev = process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
    if (value === undefined) delete process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
    else process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
      else process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] = prev;
    }
  }

  it('prepends a stashed notice to the stand-in reply exactly once', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'collapse@s.whatsapp.net';
    withFlag('1', () => {
      expect(v.stashHandoffNotice(chat, 'Primary model hit a limit. I will continue here.', Date.now())).toBe(true);
      expect(v.withHandoffPrefix(chat, 'here is the answer')).toBe(
        'Primary model hit a limit. I will continue here.\n\nhere is the answer',
      );
      // Latch consumed — the next reply is unprefixed.
      expect(v.withHandoffPrefix(chat, 'a later reply')).toBe('a later reply');
    });
    db.close();
  });

  it('leaves the reply unchanged when the flag is off, even with a notice stashed', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'collapse2@s.whatsapp.net';
    // Stash is unconditional; consume is flag-gated.
    v.stashHandoffNotice(chat, 'should not appear', Date.now());
    withFlag(undefined, () => {
      expect(v.withHandoffPrefix(chat, 'plain reply')).toBe('plain reply');
    });
    db.close();
  });

  it('flushes a pending notice standalone at turn end when no reply consumed it', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'flush@s.whatsapp.net';
    const enqueued: string[] = [];
    const queue = { targetChatJid: chat, enqueueText: (t: string) => { enqueued.push(t); } };
    withFlag('1', () => {
      v.stashHandoffNotice(chat, 'pending notice', Date.now());
      v.flushPendingHandoffNotice(queue);
      expect(enqueued).toEqual(['pending notice']);
      // Consumed — a second flush is a no-op.
      v.flushPendingHandoffNotice(queue);
      expect(enqueued).toEqual(['pending notice']);
    });
    db.close();
  });

  it('flush is a no-op once a reply has already prepended the notice', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'flush2@s.whatsapp.net';
    const enqueued: string[] = [];
    const queue = { targetChatJid: chat, enqueueText: (t: string) => { enqueued.push(t); } };
    withFlag('1', () => {
      v.stashHandoffNotice(chat, 'notice', Date.now());
      expect(v.withHandoffPrefix(chat, 'reply')).toBe('notice\n\nreply');
      v.flushPendingHandoffNotice(queue);
      expect(enqueued).toEqual([]);
    });
    db.close();
  });
});

describe('handoff context injection (real db)', () => {
  const CONTEXT_FLAG = 'WHATSOUP_HANDOFF_CONTEXT';
  // Header emitted by buildHandoffPrelude's system block (handoff-prelude.ts).
  const SUMMARY_HEADER = '[Handoff context — prior conversation summary]';

  function makeRealDbRuntime(): { runtime: AgentRuntime; db: Database } {
    const config = mockConfigRef();
    config['agentProvider'] = 'claude-cli';
    config['agentProviderConfig'] = undefined;
    config['agentFallbackProvider'] = 'opencode-cli';
    config['agentFallbackModel'] = undefined;
    const db = new Database(':memory:');
    db.open();
    // start() ensures this schema in production; mirror it here without the rest
    // of start()'s heavy setup.
    ensureHandoffArtifactSchema(db);
    const runtime = new AgentRuntime(db, makeMessenger(), 'test', { model: 'claude-opus-4-8[1m]' });
    return { runtime, db };
  }

  function withFlag(value: '1' | undefined, fn: () => void): void {
    const prev = process.env[CONTEXT_FLAG];
    if (value === undefined) delete process.env[CONTEXT_FLAG];
    else process.env[CONTEXT_FLAG] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[CONTEXT_FLAG];
      else process.env[CONTEXT_FLAG] = prev;
    }
  }

  function seedArtifact(db: Database, conversationKey: string, summary: string): void {
    upsertHandoffArtifact(db, {
      conversationKey,
      summary,
      seededArtifacts: null,
      updatedAt: Date.now(), // fresh — within HANDOFF_STALE_MS
      sourceProvider: 'claude-cli',
      sourceModel: 'claude-opus-4-8[1m]',
      tokenBaseline: 0,
    });
  }

  it('flag off → no callback (byte-identical: system prompt is untouched)', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'ctx-off@s.whatsapp.net';
    seedArtifact(db, chat, 'prior summary should NOT appear');
    withFlag(undefined, () => {
      expect(v.buildHandoffSystemBlock(chat, 'claude-cli')).toBeUndefined();
    });
    db.close();
  });

  it('flag on + fresh artifact + active fallback window → callback yields the summary block', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'ctx-on@s.whatsapp.net';
    seedArtifact(db, chat, 'User is migrating their config; open task: finish the cutover.');
    // The handoff summary seeds a STAND-IN, so it only injects during an active
    // fallback window.
    v.activateProviderFallback(new Date(Date.now() + 600_000), 'usage-limit');
    withFlag('1', () => {
      const cb = v.buildHandoffSystemBlock(chat, 'claude-cli');
      expect(cb).toBeTypeOf('function');
      const block = cb!();
      expect(block).toContain(SUMMARY_HEADER);
      expect(block).toContain('User is migrating their config');
    });
    db.close();
  });

  it('flag on + fresh artifact but NO fallback window (primary session) → callback yields null', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'ctx-primary@s.whatsapp.net';
    seedArtifact(db, chat, 'should NOT be injected into a primary session');
    // No fallback window activated → this is a primary session; the summary of the
    // SAME conversation must not be re-injected.
    withFlag('1', () => {
      const cb = v.buildHandoffSystemBlock(chat, 'claude-cli');
      expect(cb).toBeTypeOf('function');
      expect(cb!()).toBeNull();
    });
    db.close();
  });

  it('flag on + active window but no artifact → callback yields null (no injection)', () => {
    const { runtime, db } = makeRealDbRuntime();
    const v = view(runtime);
    const chat = 'ctx-empty@s.whatsapp.net';
    v.activateProviderFallback(new Date(Date.now() + 600_000), 'usage-limit');
    withFlag('1', () => {
      const cb = v.buildHandoffSystemBlock(chat, 'claude-cli');
      expect(cb).toBeTypeOf('function');
      expect(cb!()).toBeNull();
    });
    db.close();
  });
});

describe('AgentRuntime — background handoff distiller arming (flag-gated)', () => {
  const DISTILLER_FLAG = 'WHATSOUP_HANDOFF_DISTILLER';
  const MODEL_FLAG = 'WHATSOUP_HANDOFF_DISTILL_MODEL';

  function makeDistillRuntime(): { runtime: AgentRuntime; db: Database } {
    const config = mockConfigRef();
    config['agentProvider'] = 'claude-cli';
    config['agentProviderConfig'] = undefined;
    config['agentFallbackProvider'] = undefined;
    config['agentFallbackModel'] = undefined;
    const db = new Database(':memory:');
    db.open();
    ensureHandoffArtifactSchema(db);
    const runtime = new AgentRuntime(db, makeMessenger(), 'test', { model: 'claude-opus-4-8[1m]' });
    return { runtime, db };
  }

  /** Run fn with the distiller flag + model env set, restoring prior values. */
  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) prev[k] = process.env[k];
    for (const [k, val] of Object.entries(env)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(env)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it('flag UNSET → arms no sweep timer and constructs no runner (byte-identical)', () => {
    const { runtime, db } = makeDistillRuntime();
    const v = view(runtime);
    withEnv({ [DISTILLER_FLAG]: undefined, [MODEL_FLAG]: 'deepseek-chat', DEEPSEEK_API_KEY: 'sk' }, () => {
      v.handoffDistill.start();
      expect(v.handoffDistill.timer).toBeNull();
      expect(v.handoffDistill.runner).toBeNull();
    });
    db.close();
  });

  it('flag ON but no model/key resolves → enabled-but-inert (no timer, no runner)', () => {
    const { runtime, db } = makeDistillRuntime();
    const v = view(runtime);
    // Known flag, but unknown model id → resolveDistillModel returns null.
    withEnv({ [DISTILLER_FLAG]: '1', [MODEL_FLAG]: 'gpt-4o-mini', DEEPSEEK_API_KEY: 'sk' }, () => {
      v.handoffDistill.start();
      expect(v.handoffDistill.timer).toBeNull();
      expect(v.handoffDistill.runner).toBeNull();
    });
    db.close();
  });

  it('flag ON with a resolvable model+key → arms the sweep timer and runner (idempotent)', () => {
    const { runtime, db } = makeDistillRuntime();
    const v = view(runtime);
    withEnv({ [DISTILLER_FLAG]: '1', [MODEL_FLAG]: 'deepseek-chat', DEEPSEEK_API_KEY: 'sk-deep' }, () => {
      v.handoffDistill.start();
      expect(v.handoffDistill.timer).not.toBeNull();
      expect(v.handoffDistill.runner).not.toBeNull();
      // Idempotent: a second call does not re-arm.
      const timer = v.handoffDistill.timer;
      v.handoffDistill.start();
      expect(v.handoffDistill.timer).toBe(timer);
      // Clean up the armed interval deterministically (it is unref'd anyway).
      if (v.handoffDistill.timer) clearInterval(v.handoffDistill.timer);
      v.handoffDistill.timer = null;
    });
    db.close();
  });
});
