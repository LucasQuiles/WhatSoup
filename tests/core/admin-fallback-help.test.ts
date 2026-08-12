/**
 * Commit 5 coverage for handleFallbackCommand:
 *
 * (a) sub === 'help' replies with the static usage message.
 * (b) STATUS window shows "until <ISO> (≈<rel>)" for active windows,
 *     "none" unchanged for null.
 *
 * Harness mirrors admin-fallback.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth-admin-fallback-help',
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

interface AgentRuntimeOpts {
  effectiveProvider?: string;
  fallbackActiveUntilSet?: boolean;
  fallbackActiveUntil?: number | null;
  fallbackTurnsServed?: number;
  fallbackTurnsEmpty?: number;
  fallbackChain?: Array<{ provider: string; model?: string; eligible: boolean }>;
}

function makeAgentRuntime(opts: AgentRuntimeOpts = {}): Runtime {
  const activeUntil: number | null = opts.fallbackActiveUntilSet
    ? (opts.fallbackActiveUntil as number | null)
    : Date.now() + 5 * 60 * 60 * 1000;

  const fallbackState = {
    effectiveProvider: opts.effectiveProvider ?? 'opencode-cli',
    fallbackActiveUntil: activeUntil,
    fallbackTurnsServed: opts.fallbackTurnsServed ?? 3,
    fallbackTurnsEmpty: opts.fallbackTurnsEmpty ?? 1,
    lastFallbackTurnAt: null as number | null,
    ...(opts.fallbackChain ? { fallbackChain: opts.fallbackChain } : {}),
  };

  return {
    start: vi.fn(),
    handleMessage: vi.fn(),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn(),
    setDurability: vi.fn(),
    getFallbackState: vi.fn().mockReturnValue(fallbackState),
    forceFallback: vi.fn().mockReturnValue({ ok: true, activeUntil: Date.now() + 30 * 60_000, clamped: false }),
    disableFallback: vi.fn().mockReturnValue({ ok: true }),
  };
}

function makeChatRuntime(): Runtime {
  return {
    start: vi.fn(),
    handleMessage: vi.fn(),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn(),
    setDurability: vi.fn(),
  };
}

const helpCmd: Extract<AdminCommand, { action: 'fallback' }> = { action: 'fallback', sub: 'help' };
const statusCmd: Extract<AdminCommand, { action: 'fallback' }> = { action: 'fallback', sub: 'status' };

// ---------------------------------------------------------------------------
// FALLBACK HELP
// ---------------------------------------------------------------------------

describe('handleFallbackCommand -- FALLBACK HELP', () => {
  it('replies with static usage message containing ON, OFF, STATUS keywords', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime();

    await handleFallbackCommand(runtime, messenger, helpCmd, ADMIN_CHAT_JID);

    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('FALLBACK ON');
    expect(reply).toContain('FALLBACK OFF');
    expect(reply).toContain('FALLBACK STATUS');
  });

  it('help reply works on chat-mode runtime (no optional methods needed)', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeChatRuntime();

    await handleFallbackCommand(runtime, messenger, helpCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('FALLBACK ON');
    expect(reply).toContain('FALLBACK OFF');
    expect(reply).toContain('FALLBACK STATUS');
  });

  it('help reply mentions default duration', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime();

    await handleFallbackCommand(runtime, messenger, helpCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    // Default 5h should appear in the help text.
    expect(reply).toContain('5h');
  });
});

// ---------------------------------------------------------------------------
// FALLBACK STATUS — readable relative time
// ---------------------------------------------------------------------------

describe('handleFallbackCommand -- FALLBACK STATUS window readability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('active window shows "≈Xm" when less than 90 minutes remain', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    // 45 minutes remaining
    const activeUntil = Date.now() + 45 * 60 * 1000;
    const runtime = makeAgentRuntime({
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: activeUntil,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('≈45m');
  });

  it('active window shows "≈Xh" when 90 or more minutes remain', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    // 3 hours remaining
    const activeUntil = Date.now() + 3 * 60 * 60 * 1000;
    const runtime = makeAgentRuntime({
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: activeUntil,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('≈3h');
  });

  it('active window reply includes both ISO and relative parts', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const activeUntil = Date.now() + 30 * 60 * 1000;
    const runtime = makeAgentRuntime({
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: activeUntil,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    // ISO portion
    expect(reply).toContain(new Date(activeUntil).toISOString());
    // Relative portion
    expect(reply).toContain('≈');
  });

  it('null window still shows "none" unchanged', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: null,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('none');
    expect(reply).not.toContain('≈');
  });

  it('active window at boundary (90m exactly) uses hours format', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    // Exactly 90 minutes = 1.5h → 1 decimal → "1.5h"
    const activeUntil = Date.now() + 90 * 60 * 1000;
    const runtime = makeAgentRuntime({
      fallbackActiveUntilSet: true,
      fallbackActiveUntil: activeUntil,
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    // At or above 90m → hours format
    expect(reply).toMatch(/≈\d+(\.\d+)?h/);
  });

  it('includes ordered fallback chain readiness when available', async () => {
    const messenger = makeMockMessenger() as unknown as Messenger;
    const runtime = makeAgentRuntime({
      effectiveProvider: 'openai-api',
      fallbackChain: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
        { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
      ],
    });

    await handleFallbackCommand(runtime, messenger, statusCmd, ADMIN_CHAT_JID);

    const reply = vi.mocked(messenger.sendMessage).mock.calls[0][1] as string;
    expect(reply).toContain('chain: opencode-cli minimax/MiniMax-M2 (unavailable) -> openai-api gpt-4o-mini (ready)');
  });
});
