/**
 * Tests for handleFallbackCommand in src/core/admin.ts.
 *
 * Mocking style mirrors tests/core/admin.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    adminReplayMax: 5,
    adminReplayDelayMs: 0,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { handleFallbackCommand } from '../../src/core/admin.ts';
import type { AdminCommand } from '../../src/core/command-router.ts';
import type { Runtime } from '../../src/runtimes/types.ts';
import type { Messenger } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_CHAT_JID = '15550100001@s.whatsapp.net';

function makeMockMessenger() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

type ForceResult =
  | { ok: true; activeUntil: number; clamped: boolean }
  | { ok: false; reason: string };

interface AgentRuntimeOpts {
  effectiveProvider?: string;
  fallbackActiveUntilSet?: boolean;
  fallbackActiveUntil?: number | null;
  fallbackTurnsServed?: number;
  fallbackTurnsEmpty?: number;
  probeAttempts?: number;
  activations?: number;
  reverts?: number;
  lastFallbackTurnAt?: number | null;
  windowCostUsd?: number | null;
  forceResult?: ForceResult;
}

/** Build a Runtime mock with full fallback optional methods. */
function makeAgentRuntime(opts: AgentRuntimeOpts = {}): Runtime {
  const activeUntil: number | null = opts.fallbackActiveUntilSet
    ? (opts.fallbackActiveUntil as number | null)
    : Date.now() + 5 * 60 * 60 * 1000;

  const fallbackState = {
    effectiveProvider: opts.effectiveProvider ?? 'opencode-cli',
    fallbackActiveUntil: activeUntil,
    fallbackTurnsServed: opts.fallbackTurnsServed ?? 3,
    fallbackTurnsEmpty: opts.fallbackTurnsEmpty ?? 1,
    lastFallbackTurnAt: opts.lastFallbackTurnAt ?? null,
    probeAttempts: opts.probeAttempts ?? 0,
    fallbackActivations: opts.activations ?? 0,
    fallbackReverts: opts.reverts ?? 0,
    fallbackWindowCostUsd: opts.windowCostUsd ?? 0,
  };

  const forceResult: ForceResult = opts.forceResult
    ?? { ok: true, activeUntil: Date.now() + 30 * 60_000, clamped: false };

  return {
    start: vi.fn(),
    handleMessage: vi.fn(),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn(),
    setDurability: vi.fn(),
    getFallbackState: vi.fn().mockReturnValue(fallbackState),
    forceFallback: vi.fn().mockReturnValue(forceResult),
    disableFallback: vi.fn().mockReturnValue({ ok: true }),
  };
}

/** A chat-mode runtime with none of the optional fallback methods. */
function makeChatRuntime(): Runtime {
  return {
    start: vi.fn(),
    handleMessage: vi.fn(),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn(),
    setDurability: vi.fn(),
    // No getFallbackState, forceFallback, or disableFallback
  };
}

function onCmd(durationMs?: number): Extract<AdminCommand, { action: 'fallback' }> {
  if (durationMs !== undefined) {
    return { action: 'fallback', sub: 'on', durationMs };
  }
  return { action: 'fallback', sub: 'on' };
}

const offCmd: Extract<AdminCommand, { action: 'fallback' }> = { action: 'fallback', sub: 'off' };
const statusCmd: Extract<AdminCommand, { action: 'fallback' }> = { action: 'fallback', sub: 'status' };

// ---------------------------------------------------------------------------
// FALLBACK STATUS
// ---------------------------------------------------------------------------

describe('handleFallbackCommand -- FALLBACK STATUS', () => {
  it('replies with provider, window, and turn counters', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const activeUntil = Date.now() + 5 * 60 * 60 * 1000;
    const runtime = makeAgentRuntime({
      effectiveProvider: 'opencode-cli',
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: activeUntil,
      fallbackTurnsServed: 7,
      fallbackTurnsEmpty: 2,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('opencode-cli');
    expect(reply).toContain('7 served');
    expect(reply).toContain('2 empty');
    expect(reply).toContain('until ');
  });

  it('shows "window: none" when fallbackActiveUntil is null', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({
      effectiveProvider: 'claude-cli',
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: null,
      fallbackTurnsServed: 0,
      fallbackTurnsEmpty: 0,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('none');
  });

  it('replies "not supported" for a chat-mode runtime (no getFallbackState)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeChatRuntime();

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('not supported');
  });

  it('includes probeAttempts in the reply when non-zero', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({ probeAttempts: 5 });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('probes: 5');
  });

  it('includes activations and reverts in the reply', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({ activations: 3, reverts: 2 });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('activations: 3');
    expect(reply).toContain('reverts: 2');
  });

  it('includes cost line when windowCostUsd is non-null and non-zero', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({ windowCostUsd: 1.23 });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('$1.23');
  });

  it('omits cost line when windowCostUsd is null/absent (non-agent runtime graceful)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    // windowCostUsd = 0 → treated as absent (no meaningful cost)
    const runtime = makeAgentRuntime({ windowCostUsd: 0 });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).not.toContain('cost');
  });
});

// ---------------------------------------------------------------------------
// FALLBACK ON
// ---------------------------------------------------------------------------

describe('handleFallbackCommand -- FALLBACK ON', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replies with ISO timestamp on success (unclamped)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const activeUntil = Date.now() + 30 * 60_000;
    const runtime = makeAgentRuntime({
      forceResult: { ok: true, activeUntil, clamped: false },
    });

    await handleFallbackCommand(runtime, messenger, onCmd(30 * 60_000), ADMIN_CHAT_JID);

    expect(runtime.forceFallback).toHaveBeenCalledWith(30 * 60_000);
    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain(new Date(activeUntil).toISOString());
    expect(reply).not.toContain('clamped');
  });

  it('appends clamped note when result.clamped is true', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const activeUntil = Date.now() + 24 * 60 * 60 * 1000;
    const runtime = makeAgentRuntime({
      forceResult: { ok: true, activeUntil, clamped: true },
    });

    await handleFallbackCommand(runtime, messenger, onCmd(48 * 60 * 60 * 1000), ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('clamped');
  });

  it('passes undefined durationMs when omitted (default window)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const activeUntil = Date.now() + 5 * 60 * 60 * 1000;
    const runtime = makeAgentRuntime({
      forceResult: { ok: true, activeUntil, clamped: false },
    });

    await handleFallbackCommand(runtime, messenger, onCmd(), ADMIN_CHAT_JID);

    expect(runtime.forceFallback).toHaveBeenCalledWith(undefined);
  });

  it('replies with error reason when forceFallback returns ok:false', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({
      forceResult: { ok: false, reason: 'no fallback provider or chain configured for this instance' },
    });

    await handleFallbackCommand(runtime, messenger, onCmd(), ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('Cannot force fallback');
    expect(reply).toContain('no fallback provider or chain');
  });

  it('replies "not supported" for a chat-mode runtime (no forceFallback)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeChatRuntime();

    await handleFallbackCommand(runtime, messenger, onCmd(), ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('not supported');
  });
});

// ---------------------------------------------------------------------------
// FALLBACK OFF
// ---------------------------------------------------------------------------

describe('handleFallbackCommand -- FALLBACK OFF', () => {
  it('calls disableFallback and confirms to admin', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime();

    await handleFallbackCommand(runtime, messenger, offCmd, ADMIN_CHAT_JID);

    expect(runtime.disableFallback).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('Fallback disabled');
    expect(reply).toContain('primary provider');
  });

  it('replies "not supported" for a chat-mode runtime (no disableFallback)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeChatRuntime();

    await handleFallbackCommand(runtime, messenger, offCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('not supported');
    expect(vi.mocked(messenger.sendMessage)).toHaveBeenCalledTimes(1);
  });
});
