import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The saga effects spawn a real helper child; mock node:child_process so the
// spawn/stdout/stderr/exit branches are driven deterministically.
const spawnMock = vi.fn();
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { buildSagaEffects, handlePairingApply, handlePairingStatus } from '../../../src/fleet/routes/ops-auth.ts';
import { acquireCoordinationLease, coordinationLeasePath, readCoordinationLease } from '../../../src/transport/coordination-lease.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { parseAccountScopeId, type CoordinationLeaseV1 } from '../../../src/transport/auth-custody-contracts.ts';

const SCOPE = parseAccountScopeId('scope:line-a-wa')!;

let root: string;
let stateRoot: string;
let authDir: string;

class FakeChild extends EventEmitter {
  constructor(closeOnExit = true) {
    super();
    if (closeOnExit) this.on('exit', (code) => this.emit('close', code));
  }
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function makeServiceManager(overrides: Record<string, unknown> = {}) {
  return {
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    startFire: vi.fn((_n: string, cb?: (e: Error | null) => void) => cb?.(null)),
    ...overrides,
  };
}

function depsWith(serviceManager: Record<string, unknown>): OpsDeps {
  return { serviceManager } as unknown as OpsDeps;
}

function effectsFor(serviceManager: Record<string, unknown>) {
  return buildSagaEffects('line-a', depsWith(serviceManager), { stateRoot, authDir }, SCOPE);
}

const lease: CoordinationLeaseV1 = {
  v: 1,
  scopeId: SCOPE,
  operationId: 'op-lease-1',
  hostId: 'host-a',
  bootId: 'boot-1',
  processBirthToken: 'birth-1',
  pid: process.pid,
  fencingToken: 3,
  mode: 'pairing',
  acquiredAt: '2026-08-18T18:00:00.000Z',
  renewedAt: '2026-08-18T18:00:00.000Z',
  expiresAt: '2026-08-18T18:10:00.000Z',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saga-effects-test-'));
  stateRoot = join(root, 'state');
  authDir = join(root, 'auth');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('buildSagaEffects.stopService', () => {
  it('uses stopForAuth when present and maps its boolean', async () => {
    const sm = makeServiceManager({ stopForAuth: vi.fn().mockResolvedValue(true) });
    expect(await effectsFor(sm).stopService()).toBe(true);

    const smFalse = makeServiceManager({ stopForAuth: vi.fn().mockResolvedValue(false) });
    expect(await effectsFor(smFalse).stopService()).toBe(false);
  });

  it('falls back to stop() when stopForAuth is absent, and reports false on throw', async () => {
    const sm = makeServiceManager();
    expect(await effectsFor(sm).stopService()).toBe(true);
    expect(sm.stop).toHaveBeenCalledWith('line-a');

    const throwing = makeServiceManager({ stop: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await effectsFor(throwing).stopService()).toBe(false);
  });
});

describe('buildSagaEffects.startService', () => {
  it('resolves true on a null error via startAfterAuthFire and false on an error', async () => {
    const ok = makeServiceManager({ startAfterAuthFire: vi.fn((_n: string, cb?: (e: Error | null) => void) => cb?.(null)) });
    expect(await effectsFor(ok).startService()).toBe(true);

    const bad = makeServiceManager({ startAfterAuthFire: vi.fn((_n: string, cb?: (e: Error | null) => void) => cb?.(new Error('x'))) });
    expect(await effectsFor(bad).startService()).toBe(false);
  });

  it('falls back to startFire when startAfterAuthFire is absent', async () => {
    const sm = makeServiceManager();
    expect(await effectsFor(sm).startService()).toBe(true);
    expect(sm.startFire).toHaveBeenCalled();
  });
});

describe('buildSagaEffects.acquireLease / releaseLease', () => {
  it('delegates acquire to the coordination lease and release is a no-throw', () => {
    const effects = effectsFor(makeServiceManager());
    const acquired = effects.acquireLease('op-effect-1');
    expect(typeof acquired.ok).toBe('boolean');
    // Whether acquisition succeeds depends on the host's default probes; the
    // delegation line is what this exercises. Release must never throw even
    // for a lease this test synthesises.
    expect(() => effects.releaseLease(lease)).not.toThrow();
    if (acquired.ok) expect(() => effects.releaseLease(acquired.lease)).not.toThrow();
  });
});

describe('buildSagaEffects.runPairingHelper', () => {
  it('waits for stdout closure before accepting the final persisted-credential event', async () => {
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    let settled = false;
    const promise = effectsFor(makeServiceManager()).runPairingHelper({ authDir, lease });
    void promise.then(() => { settled = true; });
    child.emit('exit', 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.emit('data', Buffer.from('{"event":"connected"}\n'));
    child.emit('close', 0);
    expect(await promise).toEqual({ ok: true });
  });

  it('reports unconfirmed cleanup when a timed-out helper never closes', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    const promise = effectsFor(makeServiceManager()).runPairingHelper({ authDir, lease });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_001);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await promise).toEqual({ ok: false, errorClass: 'pairing_timeout', cleanupUnconfirmed: true });
    child.emit('close', 1);
  });

  it.each([false, true])('retains the real lease until late closure and preserves a replacement: %s', async (replaced) => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    const effects = effectsFor(makeServiceManager());
    const acquired = acquireCoordinationLease({ stateRoot, scopeId: SCOPE, operationId: 'late-close-lease', mode: 'pairing', ttlMs: 600_000,
      probes: { hostId: 'fixture-host', bootId: 'fixture-boot', pid: process.pid, birthToken: () => 'fixture-birth', pidAlive: () => true, nowMs: () => Date.now() } });
    if (!acquired.ok) throw new Error(`fixture lease unavailable: ${acquired.refusal}`);
    expect(acquired.lease.operationId).toBe('late-close-lease');
    const promise = effects.runPairingHelper({ authDir, lease: acquired.lease });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_001);
    expect(await promise).toMatchObject({ ok: false, cleanupUnconfirmed: true });
    expect(readCoordinationLease(stateRoot, SCOPE)).toEqual(acquired.lease);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ accountScopeId: SCOPE }));
    const deps = { discovery: { getInstance: () => ({ name: 'line-a', configPath, stateRoot }) } } as unknown as OpsDeps;
    const request = () => mockReq({ method: 'POST', body: '{}', headers: { authorization: 'Bearer fixture' } });
    const busy = mockRes();
    await handlePairingApply(request(), busy, deps, { name: 'line-a' });
    expect(busy._status).toBe(409);
    expect(JSON.parse(busy._body).error).toContain('already in progress');
    const status = mockRes();
    await handlePairingStatus(request(), status, deps, { name: 'line-a' });
    expect(JSON.parse(status._body).lastEvent.event).toBe('cleanup_unconfirmed');
    child.stdout.emit('data', Buffer.from('{"event":"connected"}\n'));
    const lateStatus = mockRes();
    await handlePairingStatus(request(), lateStatus, deps, { name: 'line-a' });
    expect(JSON.parse(lateStatus._body).lastEvent.event).toBe('cleanup_unconfirmed');
    const replacement = { ...acquired.lease, fencingToken: acquired.lease.fencingToken + 1, operationId: 'replacement-owner' };
    if (replaced) writeFileSync(coordinationLeasePath(stateRoot, SCOPE), JSON.stringify(replacement));
    child.emit('close', 1);
    await Promise.resolve();
    expect(readCoordinationLease(stateRoot, SCOPE)).toEqual(replaced ? replacement : null);
    const closedStatus = mockRes();
    await handlePairingStatus(request(), closedStatus, deps, { name: 'line-a' });
    expect(JSON.parse(closedStatus._body).lastEvent.event).toBe(replaced ? 'cleanup_release_unconfirmed' : 'cleanup_confirmed');
    const admitted = mockRes();
    await handlePairingApply(request(), admitted, deps, { name: 'line-a' });
    expect(admitted._status).toBe(400);
    expect(JSON.parse(admitted._body).error).toContain('apply requires idempotencyKey');
  });

  it('resolves ok when the helper streams pairing_code then connected and exits 0', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const effects = effectsFor(makeServiceManager());
    const promise = effects.runPairingHelper({ authDir, lease });

    child.stdout.emit('data', Buffer.from('not-json-noise\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'pairing_code', code: 'ABCD1234' }) + '\n'));
    child.stderr.emit('data', Buffer.from('helper log line\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'connected' }) + '\n'));
    child.emit('exit', 0);

    expect(await promise).toEqual({ ok: true });
    // The delegated lease handoff env must be set on the spawn.
    const spawnEnv = spawnMock.mock.calls[0][2].env;
    expect(spawnEnv.WHATSOUP_PAIRING_LEASE_OP).toBe('op-lease-1');
    expect(spawnEnv.WHATSOUP_PAIRING_LEASE_FENCING).toBe('3');
  });

  it('handles the qr event branch and rejects an exit 0 with no connected', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = effectsFor(makeServiceManager()).runPairingHelper({ authDir, lease });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'qr', data: 'qr-payload' }) + '\n'));
    child.emit('exit', 0);
    expect(await promise).toEqual({ ok: false, errorClass: 'pairing_rejected' });
  });

  it('rejects with unknown on a nonzero exit and on a spawn error', async () => {
    const child1 = new FakeChild();
    spawnMock.mockReturnValueOnce(child1);
    const p1 = effectsFor(makeServiceManager()).runPairingHelper({ authDir, lease });
    child1.emit('exit', 1);
    expect(await p1).toEqual({ ok: false, errorClass: 'unknown' });

    const child2 = new FakeChild();
    spawnMock.mockReturnValueOnce(child2);
    const p2 = effectsFor(makeServiceManager()).runPairingHelper({ authDir, lease });
    child2.emit('error', new Error('spawn failed'));
    expect(await p2).toEqual({ ok: false, errorClass: 'unknown' });
  });

  it('reports pairing_timeout after the signalled child confirms closure', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(() => { child.emit('close', 1); });
    spawnMock.mockReturnValue(child);
    const promise = effectsFor(makeServiceManager()).runPairingHelper({ authDir, lease });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(child.kill).toHaveBeenCalled();
    expect(await promise).toEqual({ ok: false, errorClass: 'pairing_timeout' });
  });
});
