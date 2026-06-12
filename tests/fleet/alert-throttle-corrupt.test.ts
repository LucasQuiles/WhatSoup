// tests/fleet/alert-throttle-corrupt.test.ts
// Verifies that loadAlertThrottle warns when the throttle file is corrupt/unreadable.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let homeDir: string;
const logWarn = vi.hoisted(() => vi.fn());

function configDir(): string {
  return join(homeDir, '.config', 'whatsoup');
}

function throttleFile(): string {
  return join(configDir(), 'fleet-alert-throttle.json');
}

async function importStore(): Promise<typeof import('../../src/fleet/alert-throttle-store.ts')> {
  return import('../../src/fleet/alert-throttle-store.ts');
}

describe('alert throttle store corrupt-file warn', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-throttle-corrupt-'));
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal: () => Promise<typeof import('node:os')>) => {
      const actual = await importOriginal();
      return { ...actual, homedir: () => homeDir };
    });
    vi.doMock('../../src/logger.ts', () => ({
      createChildLogger: () => ({ warn: logWarn }),
    }));
    logWarn.mockClear();
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.doUnmock('../../src/logger.ts');
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('warns with file path and error when the throttle file contains invalid JSON', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(throttleFile(), '{not-json');
    const { loadAlertThrottle } = await importStore();

    loadAlertThrottle();

    expect(logWarn).toHaveBeenCalledOnce();
    const [fields, msg] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toHaveProperty('file');
    expect(typeof fields.file).toBe('string');
    expect(fields).toHaveProperty('err');
    expect(msg).toMatch(/corrupt|throttle|load/i);
  });

  it('does not warn when the file is simply missing (normal first-run)', async () => {
    // File does not exist — this is expected at startup
    const { loadAlertThrottle } = await importStore();

    loadAlertThrottle();

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('still returns an empty Map after a corrupt-file warn', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(throttleFile(), 'totally-not-json!!!');
    const { loadAlertThrottle } = await importStore();

    expect(loadAlertThrottle()).toEqual(new Map());
  });
});
