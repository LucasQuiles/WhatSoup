import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  acquireCoordinationLease,
  renewCoordinationLease,
  releaseCoordinationLease,
  forceTakeoverCoordinationLease,
  coordinationLeasePath,
  type LeaseProbes,
} from '../../src/transport/coordination-lease.ts';
import { parseCoordinationLease, parseAccountScopeId } from '../../src/transport/auth-custody-contracts.ts';

const SCOPE = parseAccountScopeId('scope:line-a-wa')!;
const T0 = Date.parse('2026-08-18T18:00:00.000Z');

let root: string;

function deadPid(): number {
  const child = spawnSync('true');
  if (typeof child.pid !== 'number') throw new Error('fixture child pid unavailable');
  return child.pid;
}

function probes(overrides: Partial<LeaseProbes> = {}): LeaseProbes {
  return {
    hostId: 'host-a',
    bootId: 'boot-current',
    pid: process.pid,
    birthToken: () => 'birth-self',
    pidAlive: pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    nowMs: () => T0,
    ...overrides,
  };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    stateRoot: root,
    scopeId: SCOPE,
    operationId: 'op-lease-0001',
    mode: 'pairing' as const,
    ttlMs: 60_000,
    probes: probes(),
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coord-lease-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('acquireCoordinationLease', () => {
  it('acquires a fresh lease with fencing token 1 and a parseable V1 payload', () => {
    const result = acquireCoordinationLease(baseArgs());
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
    expect(result.lease.fencingToken).toBe(1);
    expect(result.lease.mode).toBe('pairing');
    const onDisk = JSON.parse(readFileSync(coordinationLeasePath(root, SCOPE), 'utf-8'));
    expect(parseCoordinationLease(onDisk)).toEqual(result.lease);
  });

  it('refuses while a live verified owner holds the lease, even with a stale heartbeat', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    // Second coordinator, later clock: the first owner's heartbeat is stale
    // but the owner process (this test process) is alive with a matching
    // birth token - takeover must refuse.
    const second = acquireCoordinationLease(baseArgs({
      operationId: 'op-lease-0002',
      probes: probes({ nowMs: () => T0 + 10 * 60_000 }),
    }));
    expect(second).toEqual({ ok: false, refusal: 'held_by_live_owner' });
  });

  it('reclaims from a dead same-boot holder with an incremented fencing token and a takeover receipt', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    const lease = JSON.parse(readFileSync(coordinationLeasePath(root, SCOPE), 'utf-8'));
    lease.pid = deadPid();
    writeFileSync(coordinationLeasePath(root, SCOPE), JSON.stringify(lease));

    const second = acquireCoordinationLease(baseArgs({ operationId: 'op-lease-0002' }));
    if (!second.ok) throw new Error(`unexpected refusal: ${second.refusal}`);
    expect(second.lease.fencingToken).toBe(2);
    expect(second.takeover).toEqual(
      expect.objectContaining({ reason: 'holder_dead', priorFencingToken: 1 }),
    );
  });

  it('reclaims across a boot change', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    const second = acquireCoordinationLease(baseArgs({
      operationId: 'op-lease-0002',
      probes: probes({ bootId: 'boot-after-reboot' }),
    }));
    if (!second.ok) throw new Error(`unexpected refusal: ${second.refusal}`);
    expect(second.lease.fencingToken).toBe(2);
    expect(second.takeover?.reason).toBe('boot_changed');
  });

  it('reclaims a reused PID whose birth token no longer matches', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    const second = acquireCoordinationLease(baseArgs({
      operationId: 'op-lease-0002',
      probes: probes({ birthToken: pid => (pid === process.pid ? 'birth-DIFFERENT' : 'birth-self') }),
    }));
    if (!second.ok) throw new Error(`unexpected refusal: ${second.refusal}`);
    expect(second.takeover?.reason).toBe('pid_reused');
  });

  it('fails closed when the birth token cannot be probed for a live holder', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    const second = acquireCoordinationLease(baseArgs({
      operationId: 'op-lease-0002',
      probes: probes({ birthToken: () => null }),
    }));
    expect(second).toEqual({ ok: false, refusal: 'owner_unknown' });
  });

  it('fails closed on a remote-host lease', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    const second = acquireCoordinationLease(baseArgs({
      operationId: 'op-lease-0002',
      probes: probes({ hostId: 'host-b' }),
    }));
    expect(second).toEqual({ ok: false, refusal: 'owner_unknown' });
  });

  it('fails closed on a corrupt lease file and preserves the bytes', () => {
    writeFileSync(coordinationLeasePath(root, SCOPE), 'not json');
    const result = acquireCoordinationLease(baseArgs());
    expect(result).toEqual({ ok: false, refusal: 'lease_corrupt' });
    expect(readFileSync(coordinationLeasePath(root, SCOPE), 'utf-8')).toBe('not json');
  });

  it('keeps fencing tokens monotonic across clean release/re-acquire cycles', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    expect(releaseCoordinationLease({ stateRoot: root, scopeId: SCOPE, lease: first.lease })).toEqual({ ok: true });
    const second = acquireCoordinationLease(baseArgs({ operationId: 'op-lease-0002' }));
    if (!second.ok) throw new Error('re-acquire failed');
    expect(second.lease.fencingToken).toBe(2);
  });
});

describe('renew and release', () => {
  it('renew extends the heartbeat only for the exact fencing token holder', () => {
    const acquired = acquireCoordinationLease(baseArgs());
    if (!acquired.ok) throw new Error('fixture acquire failed');
    const renewed = renewCoordinationLease({
      stateRoot: root,
      scopeId: SCOPE,
      lease: acquired.lease,
      probes: probes({ nowMs: () => T0 + 30_000 }),
      ttlMs: 60_000,
    });
    if (!renewed.ok) throw new Error(`unexpected refusal: ${renewed.refusal}`);
    expect(Date.parse(renewed.lease.renewedAt)).toBe(T0 + 30_000);
    expect(renewed.lease.fencingToken).toBe(1);

    const stale = renewCoordinationLease({
      stateRoot: root,
      scopeId: SCOPE,
      lease: { ...acquired.lease, fencingToken: 99 },
      probes: probes({ nowMs: () => T0 + 31_000 }),
      ttlMs: 60_000,
    });
    expect(stale).toEqual({ ok: false, refusal: 'fencing_token_mismatch' });
  });

  it('release refuses a non-owner and removes the lease for the owner', () => {
    const acquired = acquireCoordinationLease(baseArgs());
    if (!acquired.ok) throw new Error('fixture acquire failed');
    expect(
      releaseCoordinationLease({
        stateRoot: root,
        scopeId: SCOPE,
        lease: { ...acquired.lease, fencingToken: 99 },
      }),
    ).toEqual({ ok: false, refusal: 'fencing_token_mismatch' });
    expect(releaseCoordinationLease({ stateRoot: root, scopeId: SCOPE, lease: acquired.lease })).toEqual({ ok: true });
    const again = acquireCoordinationLease(baseArgs({ operationId: 'op-lease-0003' }));
    expect(again.ok).toBe(true);
  });
});

describe('forceTakeoverCoordinationLease', () => {
  it('is the only path past owner_unknown and writes a durable takeover receipt', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    // A holder written by another host is owner_unknown to normal acquisition.
    const remoteHolder = { ...first.lease, hostId: 'host-b' };
    writeFileSync(coordinationLeasePath(root, SCOPE), JSON.stringify(remoteHolder));
    expect(acquireCoordinationLease(baseArgs({ operationId: 'op-lease-0002' }))).toEqual({
      ok: false,
      refusal: 'owner_unknown',
    });
    const forced = forceTakeoverCoordinationLease({
      stateRoot: root,
      scopeId: SCOPE,
      operationId: 'op-lease-0002',
      mode: 'pairing',
      ttlMs: 60_000,
      probes: probes(),
      ownerAuthorizationId: 'owner-auth-0042',
    });
    if (!forced.ok) throw new Error(`unexpected refusal: ${forced.refusal}`);
    expect(forced.lease.fencingToken).toBe(2);
    const receiptRaw = readFileSync(join(root, 'coordination-lease-takeovers.ndjson'), 'utf-8');
    const receipts = receiptRaw.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(receipts.at(-1)).toEqual(
      expect.objectContaining({
        ownerAuthorizationId: 'owner-auth-0042',
        reason: 'owner_authorized_takeover',
        priorFencingToken: 1,
      }),
    );
  });

  it('refuses without an owner authorization id', () => {
    const first = acquireCoordinationLease(baseArgs());
    if (!first.ok) throw new Error('fixture acquire failed');
    const forced = forceTakeoverCoordinationLease({
      stateRoot: root,
      scopeId: SCOPE,
      operationId: 'op-lease-0002',
      mode: 'pairing',
      ttlMs: 60_000,
      probes: probes(),
      ownerAuthorizationId: '',
    });
    expect(forced).toEqual({ ok: false, refusal: 'authorization_required' });
  });
});
