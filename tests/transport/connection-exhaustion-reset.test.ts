import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { rmSync } from 'node:fs';

// #3722: the exhaustion RESET branch (a fresh connect, not an exit). It runs
// only while exhaustionCycles < maxExhaustionCycles, so this file mocks the
// limit at 2; connection-exhaustion-exit.test.ts pins it at 1 for the exit
// branch. Paths and the temp prefix are distinct from that file so parallel
// workers never share a directory.
const { tempDataRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join: pjoin } = require('node:path');
  return { tempDataRoot: mkdtempSync(pjoin(tmpdir(), 'whatsoup-exhaustion-reset-test-')) };
});

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth-connection-exhaustion-reset',
    dataRoot: tempDataRoot,
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-connection-exhaustion-reset/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    generateHighQualityLinkPreview: false,
    maxExhaustionCycles: 2,
    models: {
      conversation: 'model-a',
      extraction: 'model-b',
      validation: 'model-b',
      fallback: 'model-c',
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
import { makeMockSocket } from '../helpers/baileys-mock.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(tempDataRoot, { recursive: true, force: true });
});

describe('ConnectionManager — exhaustion reset (#3722)', () => {
  it('records reconnectReset exhaustion_cycle_retry on the fresh-connect branch, without exiting', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as any);
    // The fresh connect() gets a socket, so the reset branch runs to its end.
    vi.mocked(makeWASocket).mockReturnValue(makeMockSocket().mockSock as any);

    const manager = new ConnectionManager();
    manager.emit('exhausted');

    // handleExhausted is async — let microtasks settle
    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(manager.getHealthConnectionState().reconnectReset?.reason).toBe('exhaustion_cycle_retry');
  });
});
