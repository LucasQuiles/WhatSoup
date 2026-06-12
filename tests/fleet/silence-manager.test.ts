// tests/fleet/silence-manager.test.ts
// Verifies that silence-manager distinguishes missing files (silent) from corrupt
// files (warn with path + error).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let homeDir: string;
const logWarn = vi.hoisted(() => vi.fn());
const logDebug = vi.hoisted(() => vi.fn());

function configDir(): string {
  return join(homeDir, '.config', 'whatsoup');
}

function silencesFile(): string {
  return join(configDir(), 'fleet-silences.json');
}

async function importManager(): Promise<typeof import('../../src/fleet/silence-manager.ts')> {
  return import('../../src/fleet/silence-manager.ts');
}

describe('silence-manager corrupt-file handling', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-silence-mgr-'));
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal: () => Promise<typeof import('node:os')>) => {
      const actual = await importOriginal();
      return { ...actual, homedir: () => homeDir };
    });
    vi.doMock('../../src/logger.ts', () => ({
      createChildLogger: () => ({ warn: logWarn, debug: logDebug }),
    }));
    logWarn.mockClear();
    logDebug.mockClear();
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.doUnmock('../../src/logger.ts');
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('does not warn when the silences file is missing (normal first-run)', async () => {
    // File does not exist — silence-manager should be quiet
    const { isInstanceSilenced } = await importManager();

    isInstanceSilenced('primary-line');

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('warns with file path and error when the silences file is corrupt JSON', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '{bad-json');
    const { isInstanceSilenced } = await importManager();

    isInstanceSilenced('primary-line');

    expect(logWarn).toHaveBeenCalledOnce();
    const [fields, msg] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toHaveProperty('file');
    expect(typeof fields.file).toBe('string');
    expect(fields).toHaveProperty('err');
    expect(msg).toMatch(/corrupt|silence|load/i);
  });

  it('returns false (no silence) after a corrupt-file warn', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), 'not valid json at all');
    const { isInstanceSilenced } = await importManager();

    expect(isInstanceSilenced('primary-line')).toBe(false);
  });

  it('returns empty array from listActiveSilences on corrupt file', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '{"not": "an array"}');
    const { listActiveSilences } = await importManager();

    expect(listActiveSilences()).toEqual([]);
  });
});
