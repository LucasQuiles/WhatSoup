import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1872: wire the merged typing circuit breaker (src/lib/typing-start-guard.ts)
// into the one canonical presence chokepoint — ConnectionManager.setTyping —
// so a failing or slow presence backend cannot repeatedly delay real message
// delivery. Fail-open: presence stays best-effort (never surfaces to callers),
// the breaker trips after N consecutive failures and skips the backend, a slow
// presence call is timeout-bounded, and a reconnect resets the breaker.
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '/tmp/wa-test-auth-typing-breaker',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off' as 'off' | 'composing' | 'recording',
    generateHighQualityLinkPreview: false,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      level: 'error',
    }),
  }),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import {
  ConnectionManager,
  TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES,
  TYPING_PRESENCE_TIMEOUT_MS,
} from '../../src/transport/connection.ts';
import { withWarmIdentity } from '../helpers/outbound-identity.ts';

const USER_JID = '15550001@s.whatsapp.net';

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;
  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.0001' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: {
      id: '15551230004:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };
  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  }
  return { mockSock, emit };
}

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

async function connected() {
  const { mockSock, emit } = makeMockSocket();
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const manager = withWarmIdentity(new ConnectionManager());
  await manager.connect();
  emit(openEvent());
  return { manager, mockSock, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.autoTyping = 'off';
});

describe('ConnectionManager typing circuit breaker (#1872)', () => {
  it('exposes a small, positive consecutive-failure trip threshold', () => {
    expect(typeof TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES).toBe('number');
    expect(TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
    expect(TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES).toBeLessThanOrEqual(5);
  });

  it('trips after N consecutive presence failures and stops hitting the backend', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendPresenceUpdate.mockRejectedValue(new Error('presence backend down'));

    // Drive many more attempts than the trip threshold. Each stays best-effort
    // (resolves undefined), but the backend must stop being called once tripped.
    for (let i = 0; i < TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES + 7; i++) {
      await expect(manager.setTyping(USER_JID, true)).resolves.toBeUndefined();
    }

    // Exactly the threshold count of backend calls: the trip attempt is the last
    // one that reaches the backend; every subsequent attempt is skipped.
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledTimes(
      TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES,
    );
  });

  it('resets the failure count after a successful presence call (no premature trip)', async () => {
    const { manager, mockSock } = await connected();
    // Fail just below the threshold, then succeed — the counter must reset so a
    // transient blip never trips the breaker.
    for (let i = 0; i < TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES - 1; i++) {
      mockSock.sendPresenceUpdate.mockRejectedValueOnce(new Error('blip'));
      await manager.setTyping(USER_JID, true);
    }
    // A success (default mock resolves) resets the count.
    await manager.setTyping(USER_JID, true);
    mockSock.sendPresenceUpdate.mockClear();
    // Now a single failure must NOT trip (counter was reset): the next call still
    // reaches the backend.
    mockSock.sendPresenceUpdate.mockRejectedValueOnce(new Error('blip2'));
    await manager.setTyping(USER_JID, true);
    await manager.setTyping(USER_JID, true);
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung presence call by the presence timeout instead of blocking forever', async () => {
    vi.useFakeTimers();
    try {
      const { manager, mockSock } = await connected();
      // Presence never settles — a hung backend.
      mockSock.sendPresenceUpdate.mockReturnValue(new Promise<void>(() => {}));
      const pending = manager.setTyping(USER_JID, true);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // Before the timeout elapses it is still pending.
      await vi.advanceTimersByTimeAsync(TYPING_PRESENCE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      // After the timeout it settles (best-effort — resolves, never throws).
      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips presence entirely on send once the breaker is tripped (no send delay)', async () => {
    mockConfig.autoTyping = 'composing';
    const { manager, mockSock } = await connected();
    mockSock.sendPresenceUpdate.mockRejectedValue(new Error('presence backend down'));
    for (let i = 0; i < TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES; i++) {
      await manager.setTyping(USER_JID, true);
    }
    mockSock.sendPresenceUpdate.mockClear();

    // With the breaker tripped, a send must not touch presence at all — neither
    // the pre-send composing nor the post-send paused call — so a failing/slow
    // presence backend cannot delay delivery.
    await manager.sendMessage(USER_JID, 'hello');

    expect(mockSock.sendPresenceUpdate).not.toHaveBeenCalled();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(USER_JID, { text: 'hello' });
  });

  it('resets the breaker on reconnect so typing resumes', async () => {
    const { manager, mockSock, emit } = await connected();
    mockSock.sendPresenceUpdate.mockRejectedValue(new Error('presence backend down'));
    for (let i = 0; i < TYPING_BREAKER_MAX_CONSECUTIVE_FAILURES; i++) {
      await manager.setTyping(USER_JID, true);
    }
    // Confirm tripped: the backend is no longer called.
    mockSock.sendPresenceUpdate.mockClear();
    await manager.setTyping(USER_JID, true);
    expect(mockSock.sendPresenceUpdate).not.toHaveBeenCalled();

    // Reconnect — the breaker resets and gives the channel a fresh chance.
    mockSock.sendPresenceUpdate.mockResolvedValue(undefined);
    emit(openEvent());
    await manager.setTyping(USER_JID, true);
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', USER_JID);
  });

  it('keeps presence best-effort: a single failure below threshold never surfaces', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendPresenceUpdate.mockRejectedValueOnce(new Error('presence boom'));
    await expect(manager.setTyping(USER_JID, true)).resolves.toBeUndefined();
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledTimes(1);
  });
});
