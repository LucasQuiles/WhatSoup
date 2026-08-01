import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, lstatSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { tempDataRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join: pjoin } = require('node:path');
  return { tempDataRoot: mkdtempSync(pjoin(tmpdir(), 'whatsoup-exhaustion-test-')) };
});

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth',
    dataRoot: tempDataRoot,
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    generateHighQualityLinkPreview: false,
    maxExhaustionCycles: 1,
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

import { ConnectionManager } from '../../src/transport/connection.ts';

const markerPath = join(tempDataRoot, 'exhausted.marker');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  if (existsSync(markerPath)) {
    rmSync(markerPath, { force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(tempDataRoot, { recursive: true, force: true });
});

describe('ConnectionManager — exhaustion limit reached', () => {
  it('writes exhausted.marker and calls process.exit(1) when exhaustion limit is reached', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as any);

    const manager = new ConnectionManager();
    manager.emit('exhausted');

    // handleExhausted is async — let microtasks settle
    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<string, unknown>;
    expect(typeof marker['timestamp']).toBe('string');
    expect(marker['cycles']).toBe(1);
    expect(marker['instanceName']).toBe('WhatSoup');
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);

  });

  it('does not write exhausted.marker through a symlink', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as any);
    const outside = join(tempDataRoot, 'outside-marker.json');
    rmSync(outside, { force: true });
    writeFileSync(outside, 'unchanged\n', { mode: 0o600 });
    symlinkSync(outside, markerPath);

    const manager = new ConnectionManager();
    manager.emit('exhausted');

    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf-8')).toBe('unchanged\n');
  });

  it('does not call process.exit when a shutdown is already in flight', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as any);

    const manager = new ConnectionManager();

    // Initiate shutdown so handleExhausted's early return fires
    void manager.shutdown();
    manager.emit('exhausted');

    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(false);

  });
});
