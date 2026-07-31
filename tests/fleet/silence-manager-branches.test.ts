// tests/fleet/silence-manager-branches.test.ts
// Branch coverage for the silence registry's strict-timestamp calendar
// validation, lifecycle-marker schema rejection, and the reset-inspection
// state matrix that gates the quarantine-and-reset workflow.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function writeRegistry(rules: unknown[]): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(silencesFile(), `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
}

function writeLifecycleMarker(marker: Record<string, unknown>): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(lifecycleMarkerFile(), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

function rule(overrides: Partial<Record<'instance' | 'until' | 'reason' | 'silencedBy' | 'createdAt', string>> = {}): Record<string, string> {
  return {
    instance: 'agent-one',
    until: '2000-03-01T00:00:00Z',
    reason: 'maintenance',
    silencedBy: 'operator',
    createdAt: '2000-02-01T00:00:00Z',
    ...overrides,
  };
}

async function importManager(): Promise<typeof import('../../src/fleet/silence-manager.ts')> {
  return import('../../src/fleet/silence-manager.ts');
}

describe('silence-manager calendar and lifecycle branches', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-silence-br-'));
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
    if (existsSync(silencesFile())) chmodSync(silencesFile(), 0o600);
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe('strict timestamp calendar validation', () => {
    it('accepts February 29th of a leap century (divisible by 400)', async () => {
      writeRegistry([rule({ until: '2000-02-29T12:00:00Z', createdAt: '2000-02-28T00:00:00Z' })]);
      const { getSilenceStoreObservation } = await importManager();

      const result = getSilenceStoreObservation();
      expect(result).toMatchObject({ availability: 'observed', readBasis: 'current' });
      expect((result as { rules: unknown[] }).rules).toHaveLength(1);
    });

    it('rejects February 29th of a non-leap century (divisible by 100 only)', async () => {
      writeRegistry([rule({ until: '1900-02-29T12:00:00Z', createdAt: '1900-02-01T00:00:00Z' })]);
      const { getSilenceStoreObservation } = await importManager();

      expect(getSilenceStoreObservation()).toMatchObject({
        availability: 'invalid',
        readBasis: 'none',
        rules: null,
        reasonClass: 'invalid_document',
      });
    });

    it('rejects an until value that is not shaped like a timestamp at all', async () => {
      writeRegistry([rule({ until: 'tomorrow' })]);
      const { getSilenceStoreObservation } = await importManager();

      expect(getSilenceStoreObservation()).toMatchObject({
        availability: 'invalid',
        readBasis: 'none',
        rules: null,
        reasonClass: 'invalid_document',
      });
    });
  });

  describe('lifecycle marker schema rejection', () => {
    it('reports a schema-invalid marker as unavailable when the registry is absent', async () => {
      writeLifecycleMarker({ schemaVersion: 1, state: 'observed' });
      const { getSilenceStoreObservation } = await importManager();

      expect(getSilenceStoreObservation()).toMatchObject({
        availability: 'unavailable',
        readBasis: 'none',
        rules: null,
        reasonClass: 'read_failed',
      });
      expect(logWarn).toHaveBeenCalledWith({}, 'silence registry lifecycle marker unavailable');
    });
  });

  describe('reset-inspection state matrix', () => {
    it('blocks reset on first run when neither registry nor marker exists', async () => {
      const { inspectSilenceRegistryReset } = await importManager();

      expect(inspectSilenceRegistryReset()).toEqual({
        state: 'blocked',
        availability: 'uninitialized',
        readBasis: 'current',
      });
    });

    it('blocks reset when the durable marker already records an uninitialized first run', async () => {
      writeLifecycleMarker({
        schemaVersion: 1,
        state: 'uninitialized',
        observedAt: '2026-07-30T00:00:00Z',
      });
      const { inspectSilenceRegistryReset } = await importManager();

      expect(inspectSilenceRegistryReset()).toEqual({
        state: 'blocked',
        availability: 'uninitialized',
        readBasis: 'current',
      });
    });

    it('blocks reset as unavailable when the marker itself cannot be trusted', async () => {
      writeLifecycleMarker({ schemaVersion: 1, state: 'observed' });
      const { inspectSilenceRegistryReset } = await importManager();

      expect(inspectSilenceRegistryReset()).toEqual({
        state: 'blocked',
        availability: 'unavailable',
        readBasis: 'none',
        reasonClass: 'read_failed',
      });
    });

    it('blocks reset as missing_after_observed when an observed registry disappears', async () => {
      const manager = await importManager();
      manager.addSilence('agent-one', 5, 'maintenance', 'operator');
      rmSync(silencesFile());

      expect(manager.inspectSilenceRegistryReset()).toEqual({
        state: 'blocked',
        availability: 'unavailable',
        readBasis: 'none',
        reasonClass: 'missing_after_observed',
      });
    });

    it('blocks reset as permission_denied when the registry cannot be opened', async () => {
      writeRegistry([]);
      chmodSync(silencesFile(), 0o000);
      const { inspectSilenceRegistryReset } = await importManager();

      expect(inspectSilenceRegistryReset()).toEqual({
        state: 'blocked',
        availability: 'unavailable',
        readBasis: 'none',
        reasonClass: 'permission_denied',
      });
    });
  });
});
