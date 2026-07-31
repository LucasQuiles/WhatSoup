// tests/fleet/silence-manager.test.ts
// Verifies that the silence manager preserves the distinction between a
// first-run registry and storage that cannot safely be used as a write basis.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

function lifecycleMarkerFile(): string {
  return join(configDir(), 'fleet-silence-registry-state.json');
}

function readStoredRules(): unknown[] {
  return JSON.parse(readFileSync(silencesFile(), 'utf-8')) as unknown[];
}

function expectObservedRules(result: unknown, rules: unknown[]): void {
  expect(result).toMatchObject({ availability: 'observed', rules });
  expect(result).toMatchObject({
    observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  });
}

function expectUninitializedRules(result: unknown): void {
  expect(result).toMatchObject({ availability: 'uninitialized', rules: [] });
  expect(result).toMatchObject({ observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
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
    vi.doUnmock('../../src/lib/private-fs.ts');
    vi.doUnmock('../../src/logger.ts');
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports an uninitialized, empty registry without warning on first run', async () => {
    const { listActiveSilences } = await importManager();

    expectUninitializedRules(listActiveSilences());
    expect(JSON.parse(readFileSync(lifecycleMarkerFile(), 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      state: 'uninitialized',
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('fails closed when the lifecycle marker cannot persist, including after restart', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = `${JSON.stringify([{
      instance: 'protected-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    }])}\n`;
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const actualPrivateFs = await vi.importActual<typeof import('../../src/lib/private-fs.ts')>(
      '../../src/lib/private-fs.ts',
    );
    const writeLifecycleMarker = vi.fn(() => {
      throw Object.assign(new Error('marker write failure'), { code: 'EACCES' });
    });
    vi.doMock('../../src/lib/private-fs.ts', () => ({
      ...actualPrivateFs,
      writeAtomicPrivateFileSync: writeLifecycleMarker,
    }));
    const { SilenceStoreUnavailableError, addSilence, listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      reasonClass: 'permission_denied',
    });
    expect(() => addSilence('new-line', 5, 'test', 'operator')).toThrow(SilenceStoreUnavailableError);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);

    unlinkSync(silencesFile());
    vi.resetModules();
    const restarted = await importManager();
    expect(restarted.listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      reasonClass: 'permission_denied',
    });
    expect(() => restarted.addSilence('new-line', 5, 'test', 'operator'))
      .toThrow(restarted.SilenceStoreUnavailableError);
    expect(writeLifecycleMarker).toHaveBeenCalledWith(
      lifecycleMarkerFile(),
      expect.any(String),
      'fleet silence registry lifecycle marker',
      'required',
    );
  });

  it('reports corrupt JSON as invalid without logging the path or raw error', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '{corrupt-registry-marker');
    const { isInstanceSilenced, listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'invalid',
      rules: null,
      reasonClass: 'invalid_json',
    });
    expect(isInstanceSilenced('primary-line')).toBeNull();

    expect(logWarn).toHaveBeenCalledOnce();
    const [fields, msg] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ availability: 'invalid', reasonClass: 'invalid_json' });
    expect(JSON.stringify(fields)).not.toContain('corrupt-registry-marker');
    expect(msg).toMatch(/registry unavailable/i);
  });

  it('reports non-Error read failures as unavailable without raw failure text', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '[]\n');
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      readFileSync: vi.fn(() => {
        throw 'simulated read failure';
      }),
    }));
    const { isInstanceSilenced, listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      rules: null,
      reasonClass: 'read_failed',
    });
    expect(isInstanceSilenced('primary-line')).toBeNull();
    expect(logWarn).toHaveBeenCalledOnce();
    const [fields] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ availability: 'unavailable', reasonClass: 'read_failed' });
  });

  it('classifies permission failures without publishing the filesystem error', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '[]\n');
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error('permission-marker'), { code: 'EACCES' });
      }),
    }));
    const { listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      reasonClass: 'permission_denied',
    });
    const [fields] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ availability: 'unavailable', reasonClass: 'permission_denied' });
    expect(JSON.stringify(fields)).not.toContain('permission-marker');
  });

  it('does not turn a corrupt registry into an unsilenced verdict', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), 'not valid json at all');
    const { isInstanceSilenced } = await importManager();

    expect(isInstanceSilenced('primary-line')).toBeNull();
  });

  it('reports a non-array document as invalid instead of an empty registry', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '{"not": "an array"}');
    const { listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'invalid',
      rules: null,
      reasonClass: 'invalid_document',
    });
    expect(logWarn).toHaveBeenCalledOnce();
    const [fields] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ availability: 'invalid', reasonClass: 'invalid_document' });
  });

  it('reports an invalid stored rule as invalid instead of trusting an unsafe cast', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), JSON.stringify([{ instance: 42 }]));
    const { listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'invalid',
      rules: null,
      reasonClass: 'invalid_document',
    });
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('accepts valid ISO-8601 rule timestamps with an explicit UTC offset', async () => {
    mkdirSync(configDir(), { recursive: true });
    const createdAt = new Date(Date.now() - 60_000).toISOString().replace('Z', '+00:00');
    const until = new Date(Date.now() + 60_000).toISOString().replace('Z', '+00:00');
    const rule = {
      instance: 'offset-line',
      until,
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt,
    };
    writeFileSync(silencesFile(), JSON.stringify([rule]));
    const { listActiveSilences } = await importManager();

    expectObservedRules(listActiveSilences(), [rule]);
  });

  it.each([
    ['invalid calendar day', '2026-02-30T00:00:00Z'],
    ['non-leap-year February day', '2025-02-29T00:00:00+00:00'],
    ['invalid timezone offset hour', '2026-06-14T00:00:00+24:00'],
  ])('rejects an %s timestamp instead of normalizing it', async (_name, invalidUntil) => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), JSON.stringify([{
      instance: 'strict-date-line',
      until: invalidUntil,
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: '2026-02-01T00:00:00Z',
    }]));
    const { isInstanceSilenced, listActiveSilences } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'invalid',
      readBasis: 'none',
      rules: null,
      reasonClass: 'invalid_document',
    });
    expect(isInstanceSilenced('strict-date-line')).toBeNull();
  });

  it('creates and lists an active silence from an empty first-run store', async () => {
    const { addSilence, isInstanceSilenced, listActiveSilences } = await importManager();

    const rule = addSilence('primary-line', 30, 'maintenance window', 'operator');

    expect(rule.instance).toBe('primary-line');
    expect(rule.reason).toBe('maintenance window');
    expect(rule.silencedBy).toBe('operator');
    expect(new Date(rule.until).getTime()).toBeGreaterThan(Date.now());
    expect(isInstanceSilenced('primary-line')).toBe(true);
    expectObservedRules(listActiveSilences(), [rule]);
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
    expectObservedRules(listActiveSilences(), [active]);
  });

  it('replaces an existing rule for the same instance instead of duplicating it', async () => {
    const { addSilence, listActiveSilences } = await importManager();

    addSilence('primary-line', 5, 'first reason', 'operator-a');
    const replacement = addSilence('primary-line', 10, 'second reason', 'operator-b');

    expectObservedRules(listActiveSilences(), [replacement]);
    expect(readStoredRules()).toEqual([replacement]);
  });

  it('removes only matching silences and reports a missing removal', async () => {
    const { addSilence, listActiveSilences, removeSilence } = await importManager();
    const kept = addSilence('kept-line', 30, 'keep', 'operator');
    addSilence('removed-line', 30, 'remove', 'operator');

    expect(removeSilence('removed-line')).toBe(true);
    expect(removeSilence('missing-line')).toBe(false);

    expectObservedRules(listActiveSilences(), [kept]);
    expect(readStoredRules()).toEqual([kept]);
  });

  it('keeps non-Error load failures unavailable without publishing their text', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '[]\n');
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

    expect(listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      rules: null,
      reasonClass: 'read_failed',
    });
    expect(logWarn).toHaveBeenCalledOnce();
    const [fields, msg] = logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ availability: 'unavailable', reasonClass: 'read_failed' });
    expect(msg).toMatch(/registry unavailable/i);
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
    const priorContents = `${JSON.stringify([{
      instance: 'prior-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'prior maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    }])}\n`;
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const chmodCalls: Array<{ target: string; mode: number }> = [];
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      chmodSync: vi.fn((target: string, mode: number) => {
        chmodCalls.push({ target, mode });
        if (target.includes('.fleet-silences.')) {
          throw new Error('simulated chmod failure');
        }
        return actualFs.chmodSync(target, mode);
      }),
    }));
    const { addSilence } = await importManager();

    expect(() => addSilence('new-line', 5, 'test', 'operator')).toThrow('simulated chmod failure');

    const stagingCalls = chmodCalls.filter(({ target }) => target.includes('.fleet-silences.'));
    expect(stagingCalls).toHaveLength(1);
    expect(stagingCalls[0]).toMatchObject({ mode: 0o600 });
    expect(stagingCalls[0]?.target).toMatch(/\.fleet-silences\..+\.tmp$/);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);
    expect(readdirSync(configDir()).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses an ordinary add when the registry is invalid and preserves the original bytes', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), priorContents);
    const { addSilence, SilenceStoreUnavailableError } = await importManager();

    expect(() => addSilence('new-line', 5, 'test', 'operator')).toThrow(SilenceStoreUnavailableError);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);
  });

  it('refuses an ordinary removal when the registry is invalid and preserves the original bytes', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), priorContents);
    const { removeSilence, SilenceStoreUnavailableError } = await importManager();

    expect(() => removeSilence('old-line')).toThrow(SilenceStoreUnavailableError);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);
  });

  it('quarantines an explicitly confirmed invalid registry before resetting it to a verified empty document', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const {
      inspectSilenceRegistryReset,
      resetInvalidSilenceRegistry,
      listActiveSilences,
    } = await importManager();

    const inspection = inspectSilenceRegistryReset();
    expect(inspection).toMatchObject({
      state: 'ready',
      reasonClass: 'invalid_json',
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');

    const result = resetInvalidSilenceRegistry(inspection.revision);

    expect(result).toMatchObject({
      state: 'verified',
      priorRevision: inspection.revision,
      nextRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      reasonClass: 'invalid_json',
    });
    expect(readFileSync(silencesFile(), 'utf-8')).toBe('[]\n');
    expect(listActiveSilences()).toMatchObject({
      availability: 'observed',
      readBasis: 'current',
      rules: [],
    });

    const quarantineDir = join(configDir(), 'fleet-silence-quarantine');
    const quarantined = readdirSync(quarantineDir);
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(quarantineDir, quarantined[0]!), 'utf-8')).toBe(priorContents);

    const receipt = readFileSync(join(configDir(), 'fleet-silence-repair-receipts.jsonl'), 'utf-8');
    expect(receipt).toContain('"phase":"verified"');
    expect(receipt).toContain(inspection.revision);
    expect(receipt).not.toContain('corrupt-registry-marker');
    expect(receipt).not.toContain(configDir());
  });

  it('refuses a reset confirmation when the invalid generation changed after inspection', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), '{first-corrupt-generation', { mode: 0o600 });
    const {
      inspectSilenceRegistryReset,
      resetInvalidSilenceRegistry,
      SilenceRegistryResetPreconditionError,
    } = await importManager();

    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');
    const currentContents = '{second-corrupt-generation';
    writeFileSync(silencesFile(), currentContents, { mode: 0o600 });

    expect(() => resetInvalidSilenceRegistry(inspection.revision))
      .toThrow(SilenceRegistryResetPreconditionError);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(currentContents);
  });

  it('restores and verifies the original bytes when post-write recovery cannot archive the replacement', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualPrivateFs = await vi.importActual<typeof import('../../src/lib/private-fs.ts')>(
      '../../src/lib/private-fs.ts',
    );
    vi.doMock('node:fs', () => ({
      ...actualFs,
      renameSync: vi.fn((from: string, to: string) => {
        if (from === silencesFile() && to.endsWith('.replacement.json')) {
          throw new Error('simulated replacement archive failure');
        }
        return actualFs.renameSync(from, to);
      }),
    }));
    vi.doMock('../../src/lib/private-fs.ts', () => ({
      ...actualPrivateFs,
      appendPrivateJsonLineSync: vi.fn((filePath: string, value: unknown) => {
        if ((value as { phase?: unknown }).phase === 'verified') {
          throw new Error('simulated verification receipt failure');
        }
        return actualPrivateFs.appendPrivateJsonLineSync(filePath, value);
      }),
    }));
    const { inspectSilenceRegistryReset, resetInvalidSilenceRegistry } = await importManager();
    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');

    expect(() => resetInvalidSilenceRegistry(inspection.revision))
      .toThrow('simulated verification receipt failure');
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);

    const receipt = readFileSync(join(configDir(), 'fleet-silence-repair-receipts.jsonl'), 'utf-8');
    expect(receipt).toContain('"phase":"aborted"');
    expect(receipt).toContain('"originalRestored":true');
    expect(receipt).not.toContain('corrupt-registry-marker');
  });

  it('retains the prior last-known-good mute when a post-write reset aborts', async () => {
    mkdirSync(configDir(), { recursive: true });
    const activeRule = {
      instance: 'maintenance-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(silencesFile(), JSON.stringify([activeRule]), { mode: 0o600 });
    const actualPrivateFs = await vi.importActual<typeof import('../../src/lib/private-fs.ts')>(
      '../../src/lib/private-fs.ts',
    );
    vi.doMock('../../src/lib/private-fs.ts', () => ({
      ...actualPrivateFs,
      appendPrivateJsonLineSync: vi.fn((filePath: string, value: unknown) => {
        if ((value as { phase?: unknown }).phase === 'verified') {
          throw new Error('simulated verification receipt failure');
        }
        return actualPrivateFs.appendPrivateJsonLineSync(filePath, value);
      }),
    }));
    const {
      inspectSilenceRegistryReset,
      isInstanceSilenced,
      listActiveSilences,
      resetInvalidSilenceRegistry,
    } = await importManager();

    expectObservedRules(listActiveSilences(), [activeRule]);
    const corruptContents = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), corruptContents, { mode: 0o600 });
    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');

    expect(() => resetInvalidSilenceRegistry(inspection.revision))
      .toThrow('simulated verification receipt failure');
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(corruptContents);
    expect(listActiveSilences()).toMatchObject({
      availability: 'invalid',
      readBasis: 'last_known_good',
      rules: [activeRule],
    });
    expect(isInstanceSilenced('maintenance-line')).toBe(true);
  });

  it('never clobbers a source recreated before no-clobber reset publication', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const replacementContents = JSON.stringify([{
      instance: 'independent-writer',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'outside update',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    }]);
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      linkSync: vi.fn((existingPath: string, newPath: string) => {
        if (newPath === silencesFile() && existingPath.includes('.fleet-silences.json.reset.')) {
          actualFs.writeFileSync(silencesFile(), replacementContents, { mode: 0o600 });
        }
        return actualFs.linkSync(existingPath, newPath);
      }),
    }));
    const { inspectSilenceRegistryReset, resetInvalidSilenceRegistry } = await importManager();
    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');

    expect(() => resetInvalidSilenceRegistry(inspection.revision)).toThrow();
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(replacementContents);

    const quarantineDir = join(configDir(), 'fleet-silence-quarantine');
    const quarantined = readdirSync(quarantineDir);
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(quarantineDir, quarantined[0]!), 'utf-8')).toBe(priorContents);
    const receipt = readFileSync(join(configDir(), 'fleet-silence-repair-receipts.jsonl'), 'utf-8');
    expect(receipt).toContain('"originalRestored":false');
  });

  it('refuses an in-place source update after quarantine verification before reset publication', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    const externalContents = '{external-in-place-generation';
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const originalIdentity = statSync(silencesFile()).ino;
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    let quarantineLinked = false;
    let readsAfterQuarantineLink = 0;
    vi.doMock('node:fs', () => ({
      ...actualFs,
      linkSync: (existingPath: string, newPath: string) => {
        actualFs.linkSync(existingPath, newPath);
        if (existingPath === silencesFile() && newPath.includes('fleet-silence-quarantine')) {
          quarantineLinked = true;
        }
      },
      readFileSync: (...args: Parameters<typeof actualFs.readFileSync>) => {
        if (quarantineLinked) {
          readsAfterQuarantineLink += 1;
          // The first descriptor read verifies the quarantine. Change the
          // linked source immediately before the pre-unlink re-read.
          if (readsAfterQuarantineLink === 2) {
            actualFs.writeFileSync(silencesFile(), externalContents, { mode: 0o600 });
          }
        }
        return actualFs.readFileSync(...args);
      },
    }));
    const { inspectSilenceRegistryReset, resetInvalidSilenceRegistry } = await importManager();
    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');

    expect(() => resetInvalidSilenceRegistry(inspection.revision)).toThrow();
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(externalContents);
    expect(statSync(silencesFile()).ino).toBe(originalIdentity);
  });

  it('does not overwrite an in-place update of the replacement while rolling back', async () => {
    mkdirSync(configDir(), { recursive: true });
    const priorContents = '{corrupt-registry-marker';
    const externalContents = '{external-update-after-publication';
    writeFileSync(silencesFile(), priorContents, { mode: 0o600 });
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualPrivateFs = await vi.importActual<typeof import('../../src/lib/private-fs.ts')>(
      '../../src/lib/private-fs.ts',
    );
    vi.doMock('../../src/lib/private-fs.ts', () => ({
      ...actualPrivateFs,
      appendPrivateJsonLineSync: vi.fn((filePath: string, value: unknown) => {
        if ((value as { phase?: unknown }).phase === 'verified') {
          actualFs.writeFileSync(silencesFile(), externalContents, { mode: 0o600 });
          throw new Error('simulated verification receipt failure');
        }
        return actualPrivateFs.appendPrivateJsonLineSync(filePath, value);
      }),
    }));
    const { inspectSilenceRegistryReset, resetInvalidSilenceRegistry } = await importManager();
    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready') throw new Error('expected reset inspection to be ready');

    expect(() => resetInvalidSilenceRegistry(inspection.revision))
      .toThrow('simulated verification receipt failure');
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(externalContents);
  });

  it('refuses a symlinked registry instead of treating the link target as current state', async () => {
    mkdirSync(configDir(), { recursive: true });
    const marker = 'linked-registry-marker';
    const target = join(homeDir, 'outside-fleet-silences.json');
    writeFileSync(target, JSON.stringify([{
      instance: 'linked-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: marker,
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    }]), { mode: 0o600 });
    symlinkSync(target, silencesFile());
    const { addSilence, isInstanceSilenced, listActiveSilences, SilenceStoreUnavailableError } = await importManager();

    expect(listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      reasonClass: 'read_failed',
    });
    expect(isInstanceSilenced('linked-line')).toBeNull();
    expect(() => addSilence('new-line', 5, 'ordinary mutation', 'operator'))
      .toThrow(SilenceStoreUnavailableError);
    expect(readFileSync(target, 'utf-8')).toContain(marker);
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(marker);
  });

  it('uses a bounded last-known-good snapshot for evaluation while a fresh read is invalid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    try {
      mkdirSync(configDir(), { recursive: true });
      const rule = {
        instance: 'maintenance-line',
        until: '2026-07-30T12:10:00.000Z',
        reason: 'maintenance',
        silencedBy: 'operator',
        createdAt: '2026-07-30T11:50:00.000Z',
      };
      writeFileSync(silencesFile(), JSON.stringify([rule]));
      const { addSilence, isInstanceSilenced, listActiveSilences } = await importManager();

      const observed = listActiveSilences();
      expectObservedRules(observed, [rule]);
      writeFileSync(silencesFile(), '{corrupt-registry-marker');

      expect(listActiveSilences()).toMatchObject({
        availability: 'invalid',
        readBasis: 'last_known_good',
        rules: [rule],
        reasonClass: 'invalid_json',
        lastKnownGoodAt: '2026-07-30T12:00:00.000Z',
        lastKnownGoodAgeMs: 0,
      });
      expect(isInstanceSilenced('maintenance-line')).toBe(true);
      expect(() => addSilence('another-line', 5, 'ordinary mutation', 'operator')).toThrow();
      expect(readFileSync(silencesFile(), 'utf-8')).toBe('{corrupt-registry-marker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a last-known-good snapshot instead of using it indefinitely', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    try {
      mkdirSync(configDir(), { recursive: true });
      const rule = {
        instance: 'maintenance-line',
        until: '2026-07-30T12:20:00.000Z',
        reason: 'maintenance',
        silencedBy: 'operator',
        createdAt: '2026-07-30T11:50:00.000Z',
      };
      writeFileSync(silencesFile(), JSON.stringify([rule]));
      const { isInstanceSilenced, listActiveSilences } = await importManager();

      expectObservedRules(listActiveSilences(), [rule]);
      writeFileSync(silencesFile(), '{corrupt-registry-marker');
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      expect(listActiveSilences()).toMatchObject({
        availability: 'invalid',
        rules: null,
        reasonClass: 'invalid_json',
      });
      expect(isInstanceSilenced('maintenance-line')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a fresh last-known-good snapshot extend an individual mute past its own expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    try {
      mkdirSync(configDir(), { recursive: true });
      const rule = {
        instance: 'short-window',
        until: '2026-07-30T12:00:10.000Z',
        reason: 'short maintenance',
        silencedBy: 'operator',
        createdAt: '2026-07-30T11:50:00.000Z',
      };
      writeFileSync(silencesFile(), JSON.stringify([rule]));
      const { isInstanceSilenced, listActiveSilences } = await importManager();

      expect(isInstanceSilenced('short-window')).toBe(true);
      writeFileSync(silencesFile(), '{corrupt-registry-marker');
      vi.advanceTimersByTime(11_000);

      expect(listActiveSilences()).toMatchObject({
        availability: 'invalid',
        readBasis: 'last_known_good',
        rules: [],
        reasonClass: 'invalid_json',
      });
      expect(isInstanceSilenced('short-window')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a permission-denied mutation without replacing the known registry bytes', async () => {
    let failRead = false;
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      readFileSync: (...args: Parameters<typeof actualFs.readFileSync>) => {
        if (failRead) throw Object.assign(new Error('permission-marker'), { code: 'EACCES' });
        return actualFs.readFileSync(...args);
      },
    }));
    mkdirSync(configDir(), { recursive: true });
    const priorContents = JSON.stringify([{
      instance: 'prior-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    }]);
    writeFileSync(silencesFile(), priorContents);
    const { addSilence, listActiveSilences, SilenceStoreUnavailableError } = await importManager();

    expectObservedRules(listActiveSilences(), JSON.parse(priorContents));
    failRead = true;

    expect(() => addSilence('new-line', 5, 'ordinary mutation', 'operator')).toThrow(SilenceStoreUnavailableError);
    expect(readFileSync(silencesFile(), 'utf-8')).toBe(priorContents);
  });

  it('does not recategorize a post-observation disappearance as first-run absence', async () => {
    mkdirSync(configDir(), { recursive: true });
    const rule = {
      instance: 'maintenance-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(silencesFile(), JSON.stringify([rule]));
    const { listActiveSilences } = await importManager();

    expectObservedRules(listActiveSilences(), [rule]);
    rmSync(silencesFile());

    expect(listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      readBasis: 'last_known_good',
      rules: [rule],
      reasonClass: 'missing_after_observed',
    });
  });

  it('retains the observed-generation marker across a restart before classifying a missing registry', async () => {
    mkdirSync(configDir(), { recursive: true });
    const rule = {
      instance: 'maintenance-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(silencesFile(), JSON.stringify([rule]));
    const firstProcess = await importManager();

    expectObservedRules(firstProcess.listActiveSilences(), [rule]);
    rmSync(silencesFile());
    vi.resetModules();
    const restartedProcess = await importManager();

    expect(restartedProcess.listActiveSilences()).toMatchObject({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      reasonClass: 'missing_after_observed',
    });
  });

});
