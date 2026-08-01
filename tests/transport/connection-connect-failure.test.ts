import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    generateHighQualityLinkPreview: false,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionManager — connect() failure path', () => {
  it('does not throw when makeWASocket throws and schedules a reconnect attempt', async () => {
    vi.mocked(makeWASocket).mockImplementationOnce(() => {
      throw new Error('socket construction failed');
    });

    const manager = new ConnectionManager();

    await expect(manager.connect()).resolves.toBeUndefined();

    // The first call failed; a reconnect should be queued on the standard 1s backoff.
    // Advance just under and verify it has not fired again.
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    // Make the next attempt succeed so we observe the reconnect at t=1000ms.
    const mockSock = {
      ev: { process: vi.fn() },
      sendMessage: vi.fn(),
      query: vi.fn(),
      end: vi.fn(),
      ws: { isOpen: true },
      user: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid', name: 'WhatSoup' },
    };
    vi.mocked(makeWASocket).mockReturnValueOnce(mockSock as any);

    await vi.advanceTimersByTimeAsync(2);

    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);
  });

  it('returns immediately without creating a socket when shutdown has been requested', async () => {
    const manager = new ConnectionManager();

    await manager.shutdown();
    await manager.connect();

    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();

    // No reconnect should ever fire either.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
  });
});
