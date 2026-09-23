// tests/transport/coordination-lease-isolated-write.test.ts
// The lease is created and renewed through the isolated private-file writers.
// Acquisition must stay an exclusive create (a racer's lease is never
// replaced), a write whose publication is unknown is settled by the
// verify-after-write read, and a renewal write failure is reported as an
// io_error refusal instead of throwing out of the renewal timer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAccountScopeId } from '../../src/transport/auth-custody-contracts.ts';
import type { LeaseProbes } from '../../src/transport/coordination-lease.ts';
import { mockIsolatedChildWithHook, writeIsolatedChildHook } from '../helpers/isolated-child-hook.ts';

const SCOPE = parseAccountScopeId('scope:line-a-wa')!;
const T0 = Date.parse('2026-08-18T18:00:00.000Z');

let root: string;

function probes(): LeaseProbes {
  return {
    hostId: 'host-a',
    bootId: 'boot-current',
    pid: process.pid,
    birthToken: () => 'birth-self',
    pidAlive: () => true,
    nowMs: () => T0,
  };
}

function acquireArgs() {
  return {
    stateRoot: root,
    scopeId: SCOPE,
    operationId: 'op-lease-0001',
    mode: 'pairing' as const,
    ttlMs: 60_000,
    probes: probes(),
  };
}

async function importLease(): Promise<typeof import('../../src/transport/coordination-lease.ts')> {
  return import('../../src/transport/coordination-lease.ts');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coord-lease-isolated-'));
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../src/lib/private-fs-isolated.ts');
  vi.doUnmock('node:child_process');
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('lease acquisition through the isolated exclusive create', () => {
  it('writes a private single-link lease file', async () => {
    const lease = await importLease();
    const result = lease.acquireCoordinationLease(acquireArgs());

    expect(result.ok).toBe(true);
    const leasePath = lease.coordinationLeasePath(root, SCOPE);
    expect(statSync(leasePath).mode & 0o777).toBe(0o600);
    expect(statSync(leasePath).nlink).toBe(1);
  }, 10_000);

  it('reports lease_race_lost and preserves the racer lease when the racer creates it first', async () => {
    const leaseFile = `coordination-lease.${SCOPE.replace(':', '_')}.json`;
    const hookPath = writeIsolatedChildHook(root, 'lease-race-hook.mjs', String.raw`
import fs from 'node:fs';
const originalLink = fs.linkSync.bind(fs);
fs.linkSync = function (from, to) {
  if (String(to) === ${JSON.stringify(leaseFile)}) fs.writeFileSync(to, 'racer-lease', { mode: 0o600, flag: 'wx' });
  return originalLink(from, to);
};
`);
    await mockIsolatedChildWithHook(hookPath);
    const lease = await importLease();

    const result = lease.acquireCoordinationLease(acquireArgs());

    expect(result).toEqual({ ok: false, refusal: 'lease_race_lost' });
    expect(readFileSync(lease.coordinationLeasePath(root, SCOPE), 'utf-8')).toBe('racer-lease');
  }, 10_000);

  it.each([
    ['unknown publication, lease actually on disk', 'unknown', true, true],
    ['unknown publication, nothing on disk', 'unknown', false, false],
    ['not published (I/O error)', 'not-published', false, false],
  ] as const)('settles a failed create by reading back: %s', async (_name, publication, writeFirst, expectOk) => {
    vi.doMock('../../src/lib/private-fs-isolated.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/lib/private-fs-isolated.ts')>()),
      createPrivateFileIsolatedSync: vi.fn((filePath: string, data: string) => {
        if (writeFirst) writeFileSync(filePath, data, { mode: 0o600, flag: 'wx' });
        throw Object.assign(new Error('simulated create failure'), { code: 'EIO', publication });
      }),
    }));
    const lease = await importLease();

    const result = lease.acquireCoordinationLease(acquireArgs());

    if (expectOk) expect(result).toMatchObject({ ok: true, lease: { fencingToken: 1 } });
    else expect(result).toEqual({ ok: false, refusal: 'io_error' });
  });
});

describe('lease renewal write failure', () => {
  it('returns an io_error refusal instead of throwing, and leaves the lease on disk unchanged', async () => {
    const acquiredModule = await importLease();
    const acquired = acquiredModule.acquireCoordinationLease(acquireArgs());
    if (!acquired.ok) throw new Error(`unexpected refusal: ${acquired.refusal}`);
    const leasePath = acquiredModule.coordinationLeasePath(root, SCOPE);
    const before = readFileSync(leasePath, 'utf-8');

    vi.resetModules();
    const failingWrite = vi.fn(() => {
      throw Object.assign(new Error('owned child exceeded its execution deadline'), {
        code: 'ETIMEDOUT',
        publication: 'unknown',
      });
    });
    vi.doMock('../../src/lib/private-fs-isolated.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/lib/private-fs-isolated.ts')>()),
      writeAtomicPrivateFileIsolatedSync: failingWrite,
    }));
    const lease = await importLease();

    let result: ReturnType<typeof lease.renewCoordinationLease> | undefined;
    expect(() => {
      result = lease.renewCoordinationLease({
        stateRoot: root,
        scopeId: SCOPE,
        lease: acquired.lease,
        ttlMs: 60_000,
        probes: probes(),
      });
    }).not.toThrow();

    expect(failingWrite).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, refusal: 'io_error' });
    expect(readFileSync(leasePath, 'utf-8')).toBe(before);
  }, 10_000);
});
