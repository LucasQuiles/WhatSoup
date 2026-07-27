// tests/fleet/silence-manager.test.ts
// Verifies that silence-manager distinguishes missing files (silent) from corrupt
// files (warn with path + error).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function readStoredRules(): unknown[] {
  return JSON.parse(readFileSync(silencesFile(), 'utf-8')) as unknown[];
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
    vi.doUnmock('node:fs');
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

  it('stringifies non-Error read failures in the warning payload', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      readFileSync: vi.fn(() => {
        throw 'simulated read failure';
      }),
    }));
    const { isInstanceSilenced } = await importManager();

    expect(isInstanceSilenced('primary-line')).toBe(false);
    expect(logWarn).toHaveBeenCalledOnce();
    const [fields] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.err).toBe('simulated read failure');
  });

  it('returns false (no silence) after a corrupt-file warn', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), 'not valid json at all');
    const { isInstanceSilenced } = await importManager();

    expect(isInstanceSilenced('primary-line')).toBe(false);
  });

  it('returns empty array and warns when the file is valid JSON but not an array', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '{"not": "an array"}');
    const { listActiveSilences } = await importManager();

    expect(listActiveSilences()).toEqual([]);
    expect(logWarn).toHaveBeenCalledOnce();
    const [fields] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toHaveProperty('file');
  });

  it('creates and lists an active silence from an empty first-run store', async () => {
    const { addSilence, isInstanceSilenced, listActiveSilences } = await importManager();

    const rule = addSilence('primary-line', 30, 'maintenance window', 'operator');

    expect(rule.instance).toBe('primary-line');
    expect(rule.reason).toBe('maintenance window');
    expect(rule.silencedBy).toBe('operator');
    expect(new Date(rule.until).getTime()).toBeGreaterThan(Date.now());
    expect(isInstanceSilenced('primary-line')).toBe(true);
    expect(listActiveSilences()).toEqual([rule]);
    expect(readStoredRules()).toEqual([rule]);
  });

  it('filters expired rules from active checks and active silence listings', async () => {
    mkdirSync(configDir(), { recursive: true });
    const expired = {
      instance: 'expired-line',
      until: new Date(Date.now() - 60_000).toISOString(),
      reason: 'old outage',
      silencedBy: 'operator',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    };
    const active = {
      instance: 'active-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'current outage',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(silencesFile(), JSON.stringify([expired, active]));
    const { isInstanceSilenced, listActiveSilences } = await importManager();

    expect(isInstanceSilenced('expired-line')).toBe(false);
    expect(isInstanceSilenced('active-line')).toBe(true);
    expect(listActiveSilences()).toEqual([active]);
  });

  it('replaces an existing rule for the same instance instead of duplicating it', async () => {
    const { addSilence, listActiveSilences } = await importManager();

    addSilence('primary-line', 5, 'first reason', 'operator-a');
    const replacement = addSilence('primary-line', 10, 'second reason', 'operator-b');

    expect(listActiveSilences()).toEqual([replacement]);
    expect(readStoredRules()).toEqual([replacement]);
  });

  it('removes only matching silences and reports a missing removal', async () => {
    const { addSilence, listActiveSilences, removeSilence } = await importManager();
    const kept = addSilence('kept-line', 30, 'keep', 'operator');
    addSilence('removed-line', 30, 'remove', 'operator');

    expect(removeSilence('removed-line')).toBe(true);
    expect(removeSilence('missing-line')).toBe(false);

    expect(listActiveSilences()).toEqual([kept]);
    expect(readStoredRules()).toEqual([kept]);
  });

  it('logs non-Error load failures without assuming an Error shape', async () => {
    vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        readFileSync: () => {
          throw 'non-error read failure';
        },
      };
    });
    const { listActiveSilences } = await importManager();

    expect(listActiveSilences()).toEqual([]);
    expect(logWarn).toHaveBeenCalledOnce();
    const [fields, msg] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.err).toBe('non-error read failure');
    expect(msg).toMatch(/failed to load silence file/i);
  });

  it('recognizes only matching, unexpired silences as active', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      silencesFile(),
      JSON.stringify([
        {
          instance: 'primary-line',
          until: new Date(Date.now() + 60_000).toISOString(),
          reason: 'maintenance',
          silencedBy: 'operator',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
        {
          instance: 'expired-line',
          until: new Date(Date.now() - 60_000).toISOString(),
          reason: 'stale',
          silencedBy: 'operator',
          createdAt: '2026-06-13T00:00:00.000Z',
        },
      ]),
    );
    const { isInstanceSilenced } = await importManager();

    expect(isInstanceSilenced('primary-line')).toBe(true);
    expect(isInstanceSilenced('expired-line')).toBe(false);
    expect(isInstanceSilenced('missing-line')).toBe(false);
  });

  it('preserves the prior file when private permissions cannot be staged before publication', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '[{"instance":"prior-line"}]\n';
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const chmodCalls: Array<{ target: string; mode: number }> = [];
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      chmodSync: vi.fn((target: string, mode: number) => {
        chmodCalls.push({ target, mode });
        throw new Error('simulated chmod failure');
      }),
    }));
    const { addSilence } = await importManager();

    expect(() => addSilence('new-line', 5, 'test', 'operator')).toThrow('simulated chmod failure');

    expect(chmodCalls).toHaveLength(1);
    expect(chmodCalls[0]).toMatchObject({ mode: 0o600 });
    expect(chmodCalls[0]?.target).toMatch(/\.fleet-silences\..+\.tmp$/);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);
    expect(readdirSync(configDir()).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});
