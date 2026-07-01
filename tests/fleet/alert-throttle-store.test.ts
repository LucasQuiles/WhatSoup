import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let homeDir: string;

function configDir(): string {
  return join(homeDir, '.config', 'whatsoup');
}

function throttleFile(): string {
  return join(configDir(), 'fleet-alert-throttle.json');
}

async function importStore(): Promise<typeof import('../../src/fleet/alert-throttle-store.ts')> {
  return import('../../src/fleet/alert-throttle-store.ts');
}

describe('alert throttle store', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-alert-throttle-'));
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal: () => Promise<typeof import('node:os')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        homedir: () => homeDir,
      };
    });
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('loads an empty map when the throttle file is missing', async () => {
    const { loadAlertThrottle } = await importStore();

    expect(loadAlertThrottle()).toEqual(new Map());
  });

  it('loads an empty map when the throttle file is corrupt', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(throttleFile(), '{not-json');
    const { loadAlertThrottle, loadAlertThrottleDetailed } = await importStore();

    expect(loadAlertThrottle()).toEqual(new Map());
    expect(loadAlertThrottleDetailed()).toMatchObject({
      entries: new Map(),
      loadError: {
        file: throttleFile(),
      },
    });
  });

  it('exposes malformed throttle shape as loadError without losing compatibility map shape', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(throttleFile(), '[]');
    const { loadAlertThrottle, loadAlertThrottleDetailed } = await importStore();

    expect(loadAlertThrottle()).toEqual(new Map());
    expect(loadAlertThrottleDetailed()).toEqual({
      entries: new Map(),
      loadError: {
        file: throttleFile(),
        error: 'throttle file root is not an object',
      },
    });
  });

  it('filters stale and non-string throttle entries while preserving fresh entries', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(throttleFile(), JSON.stringify({
      fresh: '2026-05-20T11:59:00.000Z',
      stale: '2026-05-20T11:00:00.000Z',
      numeric: Date.parse('2026-05-20T11:59:00.000Z'),
      invalid: 'not-a-date',
    }));
    const { loadAlertThrottleDetailed } = await importStore();

    expect(loadAlertThrottleDetailed(Date.parse('2026-05-20T12:00:00.000Z'))).toEqual({
      entries: new Map([
        ['fresh', '2026-05-20T11:59:00.000Z'],
      ]),
      loadError: null,
    });
  });

  it('returns a coded loadError when the throttle file cannot be read as a file', async () => {
    mkdirSync(throttleFile(), { recursive: true });
    const { loadAlertThrottleDetailed } = await importStore();

    expect(loadAlertThrottleDetailed()).toMatchObject({
      entries: new Map(),
      loadError: {
        file: throttleFile(),
        code: 'EISDIR',
      },
    });
  });

  it('records and reloads fresh throttle timestamps with private file permissions', async () => {
    const now = Date.parse('2026-05-20T12:00:00.000Z');
    const { loadAlertThrottle, recordAlertThrottle } = await importStore();

    recordAlertThrottle('line-a', '2026-05-20T12:00:00.000Z', now);

    expect(loadAlertThrottle(now)).toEqual(new Map([
      ['line-a', '2026-05-20T12:00:00.000Z'],
    ]));
    expect(JSON.parse(readFileSync(throttleFile(), 'utf-8'))).toEqual({
      'line-a': '2026-05-20T12:00:00.000Z',
    });
    expect(statSync(throttleFile()).mode & 0o777).toBe(0o600);
  });

  it('prunes expired entries while preserving fresh entries on write', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(throttleFile(), JSON.stringify({
      expired: '2026-05-20T11:40:00.000Z',
      fresh: '2026-05-20T11:55:00.000Z',
    }));
    const now = Date.parse('2026-05-20T12:00:00.000Z');
    const { loadAlertThrottle, recordAlertThrottle } = await importStore();

    recordAlertThrottle('line-b', '2026-05-20T12:00:00.000Z', now);

    expect(loadAlertThrottle(now)).toEqual(new Map([
      ['fresh', '2026-05-20T11:55:00.000Z'],
      ['line-b', '2026-05-20T12:00:00.000Z'],
    ]));
    expect(JSON.parse(readFileSync(throttleFile(), 'utf-8'))).toEqual({
      fresh: '2026-05-20T11:55:00.000Z',
      'line-b': '2026-05-20T12:00:00.000Z',
    });
  });

  it('uses an atomic temp file and leaves no temp artifact after a successful write', async () => {
    const now = Date.parse('2026-05-20T12:00:00.000Z');
    const { recordAlertThrottle } = await importStore();

    recordAlertThrottle('line-a', '2026-05-20T12:00:00.000Z', now);

    expect(existsSync(throttleFile())).toBe(true);
    expect(readdirSync(configDir()).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  it('does not create a throttle file for stale alert timestamps', async () => {
    const now = Date.parse('2026-05-20T12:00:00.000Z');
    const { recordAlertThrottle } = await importStore();

    recordAlertThrottle('line-a', '2026-05-20T11:00:00.000Z', now);

    expect(existsSync(configDir())).toBe(false);
  });

  it('removes the temp file when the atomic rename fails', async () => {
    vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        renameSync: vi.fn(() => {
          throw Object.assign(new Error('rename failed'), { code: 'EXDEV' });
        }),
      };
    });
    const now = Date.parse('2026-05-20T12:00:00.000Z');
    const { recordAlertThrottle } = await importStore();

    expect(() => recordAlertThrottle('line-a', '2026-05-20T12:00:00.000Z', now)).toThrow('rename failed');

    expect(existsSync(throttleFile())).toBe(false);
    expect(readdirSync(configDir()).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  it('preserves the original write failure when temp cleanup also fails', async () => {
    vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        renameSync: vi.fn(() => {
          throw new Error('rename failed');
        }),
        unlinkSync: vi.fn(() => {
          throw new Error('unlink failed');
        }),
      };
    });
    const now = Date.parse('2026-05-20T12:00:00.000Z');
    const { recordAlertThrottle } = await importStore();

    expect(() => recordAlertThrottle('line-a', '2026-05-20T12:00:00.000Z', now)).toThrow('rename failed');

    expect(readdirSync(configDir()).filter((entry) => entry.includes('.tmp'))).toHaveLength(1);
  });
});
