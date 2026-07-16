// tests/runtimes/agent/session-turn-error-branches.test.ts
//
// Coverage-ratchet draft (RR-013): targets currently-UNCOVERED branches in
// src/runtimes/agent/session.ts that the existing suites
// (session.test.ts, session-provider-switches.test.ts, session-budget.test.ts,
// session-checkpoints.test.ts, zombie-sessions.test.ts, …) leave behind:
//
//   * buildChildEnv per-provider credential FORWARDING branches
//     (codex/gemini/opencode env-var present-vs-absent) — src lines ~145-203.
//     Existing tests only exercise the throw/unknown-provider paths, never the
//     "key is present → forward it" conditionals.
//   * getProviderBinary (exported) managed-loop → null branch — src line 266.
//   * opencodeUsesConfigModel true / false / whitespace — src lines 280-281.
//   * resolveProviderArgs (via __provider_switch_for_test) value branches:
//       - claude-cli model + pluginDirs + resume present  — src lines 302-304
//       - codex-cli model present                          — src line 310
//       - opencode-cli custom-endpoint baseUrl omits -m    — src line 319
//   * probeLiveness stdin.write throwing → catch branch    — src lines 1411-1413.
//   * updateMcpActorJid with context present               — src lines 519-520.
//   * notifyUnexpectedExit (driven via spawn-per-turn exit handler):
//       - code === 0 clean-exit skip (no notify)           — src lines 1318-1320
//       - non-zero exit routes through notifyUser           — src lines 1338-1340
//       - non-zero exit, no notifyUser → messenger.send     — src lines 1344-1349
//       - rate-limited second crash suppressed              — src lines 1328-1331
//
// GENUINELY-UNREACHABLE (TS-exhaustive `default: assertNeverProvider(...)`)
// branches are NOT faked here. They are proven unreachable by upstream
// `isProviderId` validation and recommended for `/* v8 ignore */`:
//   session.ts lines 211-212, 245-246, 326-327, 346-347.
// We instead prove the validator rejects the bad input (covered by
// session-provider-switches.test.ts), satisfying defense-in-depth without a
// synthetic cast that would only paper over the line.
//
// Conventions: ESM, .ts import extensions, mock child_process the same way the
// canonical session.test.ts does (this class is a long-running subprocess
// supervisor; a real subprocess is not needed for these pure/handler branches).
// Repo-hygiene reserved IDs only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks (mirror session.test.ts so behaviour matches production wiring) ──────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import { spawn } from 'node:child_process';
import {
  SessionManager,
  buildChildEnv,
  getProviderBinary,
  opencodeUsesConfigModel,
  __provider_switch_for_test,
  type SessionCrashInfo,
} from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): { messenger: Messenger; sentMessages: Array<{ jid: string; text: string }> } {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
  return { messenger, sentMessages };
}

/** Minimal mock child process whose exit/error handlers tests can drive. */
function makeMockChild(pid = 4242) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
    (_d: unknown, _e?: unknown, cb?: (err?: Error | null) => void) => {
      if (typeof _e === 'function') (_e as (err?: Error | null) => void)();
      else if (typeof cb === 'function') cb();
    },
  );
  (stdin as unknown as { end: ReturnType<typeof vi.fn> }).end = vi.fn();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
    }),
    emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
      handlers['exit']?.(code, signal);
    },
    emitClose(code: number | null, signal: NodeJS.Signals | null = null) {
      handlers['close']?.(code, signal);
    },
  };
  return child;
}
type MockChild = ReturnType<typeof makeMockChild>;

const CHAT_JID = '1555000001@s.whatsapp.net';

/** Save/restore named env vars across a test body. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await run();
  } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// buildChildEnv — per-provider credential FORWARDING branches
// ════════════════════════════════════════════════════════════════════════════

describe('buildChildEnv — credential forwarding branches', () => {
  it('claude-cli forwards OPENAI_API_KEY when present, never ANTHROPIC_API_KEY', async () => {
    await withEnv({ OPENAI_API_KEY: 'env-openai-aux', ANTHROPIC_API_KEY: 'env-anthropic' }, () => {
      const env = buildChildEnv('claude-cli');
      expect(env.OPENAI_API_KEY).toBe('env-openai-aux');
      // Claude uses subscription auth — the Anthropic key is deliberately excluded.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  it('claude-cli omits OPENAI_API_KEY when absent (false branch)', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, () => {
      const env = buildChildEnv('claude-cli');
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });
  });

  it('codex-cli forwards OPENAI_API_KEY when present', async () => {
    await withEnv({ OPENAI_API_KEY: 'env-openai-codex' }, () => {
      const env = buildChildEnv('codex-cli');
      expect(env.OPENAI_API_KEY).toBe('env-openai-codex');
    });
  });

  it('codex-cli omits OPENAI_API_KEY when absent (false branch)', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, () => {
      const env = buildChildEnv('codex-cli');
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });
  });

  it('gemini-cli forwards both GEMINI_API_KEY and GOOGLE_API_KEY when present', async () => {
    await withEnv({ GEMINI_API_KEY: 'env-gemini', GOOGLE_API_KEY: 'env-google' }, () => {
      const env = buildChildEnv('gemini-cli');
      expect(env.GEMINI_API_KEY).toBe('env-gemini');
      expect(env.GOOGLE_API_KEY).toBe('env-google');
    });
  });

  it('gemini-cli omits both keys when absent (false branches)', async () => {
    await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () => {
      const env = buildChildEnv('gemini-cli');
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
    });
  });

  it('opencode-cli forwards OPENAI_API_KEY, ANTHROPIC_API_KEY, and standard fleet keys', async () => {
    await withEnv(
      {
        OPENAI_API_KEY: 'env-openai-oc',
        ANTHROPIC_API_KEY: 'env-anthropic-oc',
        DEEPSEEK_API_KEY: 'env-deepseek',
        MINIMAX_API_KEY: 'env-minimax',
      },
      () => {
        const env = buildChildEnv('opencode-cli');
        expect(env.OPENAI_API_KEY).toBe('env-openai-oc');
        expect(env.ANTHROPIC_API_KEY).toBe('env-anthropic-oc');
        // deepseek + minimax are forwarded from the standard fleet-key Set.
        expect(env.DEEPSEEK_API_KEY).toBe('env-deepseek');
        expect(env.MINIMAX_API_KEY).toBe('env-minimax');
      },
    );
  });

  it('opencode-cli adds the model-prefix key service (e.g. xai/grok → XAI_API_KEY)', async () => {
    await withEnv({ XAI_API_KEY: 'env-xai' }, () => {
      const env = buildChildEnv('opencode-cli', undefined, 'xai/grok-4');
      expect(env.XAI_API_KEY).toBe('env-xai');
    });
  });

  it('opencode-cli adds a mapped custom-endpoint apiKeyService key', async () => {
    await withEnv({ GROQ_API_KEY: 'env-groq' }, () => {
      const env = buildChildEnv('opencode-cli', undefined, undefined, { apiKeyService: 'groq' });
      expect(env.GROQ_API_KEY).toBe('env-groq');
    });
  });

  it('opencode-cli ignores an unmapped custom-endpoint apiKeyService (warn path, no forward)', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, () => {
      const env = buildChildEnv('opencode-cli', undefined, undefined, {
        apiKeyService: 'not-a-real-service',
      });
      // Unmapped service → no env var injected for it; defaults still resolve to nothing.
      expect(env['NOT_A_REAL_SERVICE_API_KEY']).toBeUndefined();
    });
  });

  it('opencode-cli treats a blank apiKeyService as undefined (whitespace branch)', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, () => {
      // Should not throw and should not forward anything from the blank service.
      const env = buildChildEnv('opencode-cli', undefined, undefined, { apiKeyService: '   ' });
      expect(env).toBeTypeOf('object');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// getProviderBinary (exported) — managed-loop returns null
// ════════════════════════════════════════════════════════════════════════════

describe('getProviderBinary (exported pre-flight helper)', () => {
  it('returns null for managed-loop providers (no child binary)', () => {
    expect(getProviderBinary('openai-api')).toBeNull();
    expect(getProviderBinary('anthropic-api')).toBeNull();
  });

  it('returns the CLI binary name for spawn providers', () => {
    expect(getProviderBinary('claude-cli')).toBe('claude');
    expect(getProviderBinary('opencode-cli')).toBe('opencode');
  });

  it('throws on an unknown provider id (defense in depth)', () => {
    expect(() => getProviderBinary('totally-bogus')).toThrow(/unknown provider/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// opencodeUsesConfigModel — true / false / whitespace branches
// ════════════════════════════════════════════════════════════════════════════

describe('opencodeUsesConfigModel', () => {
  it('is true when a non-empty baseUrl is configured', () => {
    expect(opencodeUsesConfigModel({ baseUrl: 'https://endpoint.example/v1' })).toBe(true);
  });

  it('is false when providerConfig is undefined', () => {
    expect(opencodeUsesConfigModel(undefined)).toBe(false);
  });

  it('is false when baseUrl is absent', () => {
    expect(opencodeUsesConfigModel({ model: 'foo' })).toBe(false);
  });

  it('is false when baseUrl is blank/whitespace', () => {
    expect(opencodeUsesConfigModel({ baseUrl: '   ' })).toBe(false);
  });

  it('is false when baseUrl is a non-string', () => {
    expect(opencodeUsesConfigModel({ baseUrl: 123 } as Record<string, unknown>)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveProviderArgs (via __provider_switch_for_test) — value branches
// ════════════════════════════════════════════════════════════════════════════

describe('resolveProviderArgs — conditional argv branches', () => {
  it('claude-cli includes --model, --plugin-dir per dir, and --resume when all present', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'claude-cli',
      'SYS',
      '/home/testuser',
      'resume-abc',
      'some-model',
      ['/plug/a', '/plug/b'],
    );
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('SYS');
    expect(args.join(' ')).toContain('--model some-model');
    expect(args.filter((a) => a === '--plugin-dir')).toHaveLength(2);
    expect(args).toContain('/plug/a');
    expect(args).toContain('/plug/b');
    expect(args.join(' ')).toContain('--resume resume-abc');
  });

  it('claude-cli omits --model/--resume when absent (false branches)', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'claude-cli', 'SYS', '/home/testuser', undefined, undefined, [],
    );
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--plugin-dir');
  });

  it('codex-cli includes --model when a model is set', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'codex-cli', 'SYS', '/home/testuser', undefined, 'codex-model', [],
    );
    expect(args).toContain('app-server');
    expect(args.join(' ')).toContain('--model codex-model');
  });

  it('codex-cli omits --model when absent', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'codex-cli', 'SYS', '/home/testuser', undefined, undefined, [],
    );
    expect(args).not.toContain('--model');
  });

  it('opencode-cli adds -m for a plain model (no custom endpoint)', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'opencode-cli', 'SYS', '/home/testuser', undefined, 'deepseek/x', [], undefined,
    );
    expect(args.join(' ')).toContain('-m deepseek/x');
  });

  it('opencode-cli omits -m when a custom-endpoint baseUrl is configured', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'opencode-cli', 'SYS', '/home/testuser', undefined, 'deepseek/x', [],
      { baseUrl: 'https://endpoint.example/v1' },
    );
    expect(args).not.toContain('-m');
    expect(args).toContain('--pure');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// updateMcpActorJid — context-present mutation branch
// ════════════════════════════════════════════════════════════════════════════

describe('SessionManager.updateMcpActorJid', () => {
  it('mutates actorJid when an mcpSessionContext exists', () => {
    const ctx = { tier: 'global', actorJid: undefined } as unknown as SessionContext;
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      mcpSessionContext: ctx,
    });
    sm.updateMcpActorJid('1555000002@s.whatsapp.net');
    expect((ctx as unknown as { actorJid: string }).actorJid).toBe('1555000002@s.whatsapp.net');
  });

  it('is a safe no-op when no mcpSessionContext exists (false branch)', () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    expect(() => sm.updateMcpActorJid('1555000003@s.whatsapp.net')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// probeLiveness — stdin.write throw → catch branch
// ════════════════════════════════════════════════════════════════════════════

describe('SessionManager.probeLiveness — write failure path', () => {
  let mockChild: MockChild;
  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });
  afterEach(() => vi.restoreAllMocks());

  it('swallows a stdin.write error without throwing (catch branch)', async () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    await sm.spawnSession();
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('EPIPE: broken pipe');
    });
    // Must not propagate — failure is logged and swallowed.
    expect(() => sm.probeLiveness()).not.toThrow();
    expect(mockChild.stdin.write).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// notifyUnexpectedExit — driven through the spawn-per-turn exit handler
//   (opencode-cli is the spawn-per-turn provider; codex/gemini are persistent)
// ════════════════════════════════════════════════════════════════════════════

describe('notifyUnexpectedExit via spawn-per-turn exit handler', () => {
  let mockChild: MockChild;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockChild = makeMockChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function startTurn(opts: {
    notifyUser?: (m: string) => void;
    messenger?: Messenger;
    onCrash?: (info: SessionCrashInfo) => void;
    providerConfig?: Record<string, unknown>;
  }) {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: opts.messenger ?? makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      onCrash: opts.onCrash ?? vi.fn(),
      notifyUser: opts.notifyUser,
      providerConfig: opts.providerConfig,
    });
    await sm.spawnSession();
    // Begin a turn so a fresh spawn-per-turn child + exit handler is wired.
    await sm.sendTurn('hello');
    // Disarm the per-turn watchdog so flushing timers does not jump the fake
    // clock forward to the far-future watchdog deadlines (which would blow past
    // the crash-notify cooldown window). The real exit handler clears the
    // watchdog too; doing it here keeps the test's timer flush local to the
    // setImmediate-deferred drain + notify chain.
    sm.clearTurnWatchdog();
    return sm;
  }

  // The exit handler drain and the notifyUnexpectedExit dispatch both run via
  // setImmediate. runOnlyPendingTimersAsync flushes that nested chain. The turn
  // watchdog is disarmed by startTurn()/the rate-limit test before each emitExit,
  // so this flush stays at the current fake time and does not jump past the
  // crash-notify cooldown window.
  async function flushImmediates(): Promise<void> {
    await vi.runAllTimersAsync();
  }

  it('code 0 clean exit produces no crash notification', async () => {
    const notifyUser = vi.fn();
    await startTurn({ notifyUser });
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop' },
    })));
    mockChild.emitExit(0, null);
    mockChild.emitClose(0, null);
    await flushImmediates();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('non-zero exit routes the crash notice through notifyUser when provided', async () => {
    const notifyUser = vi.fn();
    await startTurn({ notifyUser });
    mockChild.emitExit(1, null);
    mockChild.emitClose(1, null);
    await flushImmediates();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(String(notifyUser.mock.calls[0][0])).toMatch(/exited with code 1/);
  });

  it('non-zero exit falls back to messenger.sendMessage when no notifyUser', async () => {
    const { messenger, sentMessages } = makeMessenger();
    await startTurn({ messenger });
    mockChild.emitExit(2, null);
    mockChild.emitClose(2, null);
    await flushImmediates();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe(CHAT_JID);
    expect(sentMessages[0].text).toMatch(/exited with code 2/);
  });

  it('signal-only exit routes crash, notification, and budget cancellation', async () => {
    const notifyUser = vi.fn();
    const onCrash = vi.fn();
    const sm = await startTurn({
      notifyUser,
      onCrash,
      providerConfig: { budget: { requestsPerMinute: 10 } },
    });
    const budget = (sm as unknown as {
      budget: { cancelPending(): void } | null;
    }).budget;
    if (!budget) throw new Error('test budget was not initialized');
    const cancelPending = vi.spyOn(budget, 'cancelPending');

    mockChild.emitExit(null, 'SIGTERM');
    mockChild.emitClose(null, 'SIGTERM');
    await flushImmediates();

    expect(cancelPending).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
      signal: 'SIGTERM',
    }));
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(String(notifyUser.mock.calls[0][0])).toMatch(/terminated by signal SIGTERM/);
  });

  it('rate-limits a second crash notice within the cooldown window', async () => {
    const notifyUser = vi.fn();
    const sm = await startTurn({ notifyUser });
    mockChild.emitExit(1, null);
    mockChild.emitClose(1, null);
    await flushImmediates();
    expect(notifyUser).toHaveBeenCalledTimes(1);

    // Drive a second turn + crash immediately (within CRASH_NOTIFY_COOLDOWN_MS).
    const secondChild = makeMockChild(4243);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(secondChild);
    await sm.spawnSession();
    await sm.sendTurn('again');
    sm.clearTurnWatchdog(); // disarm watchdog so the flush stays within the cooldown window
    secondChild.emitExit(1, null);
    secondChild.emitClose(1, null);
    await flushImmediates();
    // Still only the first notification — the second is suppressed.
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });
});
