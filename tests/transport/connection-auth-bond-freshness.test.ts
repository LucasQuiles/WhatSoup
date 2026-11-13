/**
 * #3677 — routine lifecycle records reuse an observation instead of walking.
 *
 * The capture moved off the event loop, but connection_open and creds.update
 * still called the synchronous, full-tree AuthBondGuard.inspect() for their
 * records, so an open or a key update held the loop for a whole walk anyway.
 * These tests drive the REAL guard. Two seams are substituted, neither of which
 * is inspect() or captureAsync():
 *
 * - the capture filesystem (the guard's `captureFs` option), wrapped so every
 *   capture request waits on a valve the test opens. That is a capture whose
 *   I/O is arbitrarily slow, held deterministically rather than by wall time;
 * - drainSync, the inline step driver inspect() runs through, wrapped to count
 *   the filesystem requests it executes. A cached read drains steps with no
 *   requests, so a nonzero count on a routine path IS a synchronous tree walk,
 *   whichever public method started it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthBondCaptureFs, AuthBondGuard } from '../../src/transport/auth-bond.ts';
import type { AuthTreeSteps } from '../../src/transport/auth-bond-steps.ts';
import type { CredentialLifecycleEvent } from '../../src/transport/connection.ts';
import { usePerTestBotErrorsMarkerIsolation } from '../../tests/setup/bot-errors-vitest-isolation.ts';

const { testRoot, testAuthDir, testStateRoot, testDataRoot, syncDrain, captureIo, authState } = vi.hoisted(() => {
  // Scratch must live under the admitted run's TMPDIR (set by the resource
  // runner; os.tmpdir() semantics), never a hard-coded /tmp path — sweeps and
  // scratch-cleanup accounting only see TMPDIR-rooted paths. Direct dev runs
  // without TMPDIR fall back to /tmp, matching tmpdir() behavior.
  const testRoot = `${process.env.TMPDIR ?? '/tmp'}/wa-test-auth-bond-freshness-${process.pid}`;
  return {
    testRoot,
    testAuthDir: `${testRoot}/auth`,
    testStateRoot: `${testRoot}/state`,
    testDataRoot: `${testRoot}/data`,
    /** Filesystem requests executed by the inline step driver. */
    syncDrain: { requests: 0 },
    /** Capture filesystem requests issued, and the valve every one of them waits on. */
    captureIo: {
      calls: 0,
      valve: null as Promise<void> | null,
      release: () => {},
    },
    /** The object Baileys' auth state hands the credential saver. */
    authState: {
      creds: {
        me: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid' },
        registrationId: 1,
      } as Record<string, unknown>,
    },
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(async () => ({
    state: { creds: authState.creds, keys: {} },
    saveCreds: vi.fn(),
  })),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    connectionReplaced: 440,
    multideviceMismatch: 411,
    badSession: 500,
    unavailableService: 503,
    401: 'loggedOut',
    408: 'timedOut',
    411: 'multideviceMismatch',
    428: 'connectionClosed',
    440: 'connectionReplaced',
    500: 'badSession',
    503: 'unavailableService',
    515: 'restartRequired',
  },
  isJidGroup: vi.fn((jid: string) => jid?.endsWith('@g.us')),
  jidNormalizedUser: vi.fn((jid: string) => jid?.replace(/:.*@/, '@')),
  BufferJSON: {
    replacer: (_key: string, value: unknown) => value,
    reviver: (_key: string, value: unknown) => value,
  },
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: testAuthDir,
    stateRoot: testStateRoot,
    dataRoot: testDataRoot,
    dbPath: ':memory:',
    mediaDir: `${testRoot}/media`,
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    authBondAutoRestore: false,
    transportAuthority: { enabled: false, accountId: 'synthetic-account' },
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs = 30_000) => Math.min(baseMs * Math.pow(2, attempt), maxMs),
}));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

vi.mock('../../src/transport/auth-bond-steps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/transport/auth-bond-steps.ts')>();
  // Pass-through that counts every filesystem request the inline driver runs.
  // Errors raised into it are forwarded to the wrapped steps unchanged, so the
  // steps' own try/catch blocks see exactly what they saw before.
  function* counted<T>(steps: AuthTreeSteps<T>): AuthTreeSteps<T> {
    let step = steps.next();
    while (!step.done) {
      if (step.value !== undefined) syncDrain.requests += 1;
      let sent: unknown;
      try {
        sent = yield step.value;
      } catch (err) {
        step = steps.throw(err);
        continue;
      }
      step = steps.next(sent);
    }
    return step.value;
  }
  return {
    ...actual,
    drainSync: <T>(steps: AuthTreeSteps<T>): T => actual.drainSync(counted(steps)),
  };
});

vi.mock('../../src/transport/auth-bond.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/transport/auth-bond.ts')>();
  const real = actual.AUTH_BOND_CAPTURE_FS;
  const held = <A extends unknown[], R>(op: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    captureIo.calls += 1;
    if (captureIo.valve !== null) await captureIo.valve;
    return op(...args);
  };
  const slowCaptureFs: AuthBondCaptureFs = {
    lstat: held(real.lstat),
    readdir: held(real.readdir),
    readFile: held(real.readFile),
    mkdir: held(real.mkdir),
    chmod: held(real.chmod),
    copyFile: held(real.copyFile),
    rm: held(real.rm),
    rename: held(real.rename),
    open: held(real.open),
    unlink: held(real.unlink),
  };
  const HOUR_MS = 60 * 60 * 1000;
  /**
   * The production guard with two options set: the slow capture filesystem,
   * and a tree cache that neither ages nor refreshes on its own during a test,
   * so whether a record reads 'cached' or 'stale' is decided by the events the
   * test drives and not by how fast the host ran a background walk.
   */
  class SlowCaptureAuthBondGuard extends actual.AuthBondGuard {
    constructor(options: ConstructorParameters<typeof actual.AuthBondGuard>[0]) {
      super({ ...options, captureFs: slowCaptureFs, treeCacheMaxAgeMs: HOUR_MS, treeRefreshMinIntervalMs: HOUR_MS });
    }
  }
  return { ...actual, AuthBondGuard: SlowCaptureAuthBondGuard };
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { deferred } from '../helpers/deferred.ts';

const stagingRoot = join(testStateRoot, 'auth-bond-backups', 'WhatSoup', 'staging');
const historyRoot = join(testStateRoot, 'auth-bond-backups', 'WhatSoup', 'history');
const latestPath = join(testStateRoot, 'auth-bond-backups', 'WhatSoup', 'latest.json');
const credsPath = join(testAuthDir, 'creds.json');

interface ManagerInternals {
  authBond: AuthBondGuard;
  authSnapshotCapture: Promise<void> | null;
}

let manager: ConnectionManager | null = null;

function internals(target: ConnectionManager): ManagerInternals {
  return target as unknown as ManagerInternals;
}

function writeValidAuth(): void {
  mkdirSync(testAuthDir, { recursive: true, mode: 0o700 });
  chmodSync(testAuthDir, 0o700);
  writeFileSync(credsPath, JSON.stringify(authState.creds));
  writeFileSync(join(testAuthDir, 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'secret' }));
}

function makeMockSocket() {
  let handler: ((events: Record<string, unknown>) => Promise<void>) | undefined;
  const mockSock = {
    ev: { process: vi.fn((cb: (events: Record<string, unknown>) => Promise<void>) => { handler = cb; }) },
    sendMessage: vi.fn(),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid', name: 'WhatSoup' },
  };
  return {
    mockSock,
    /** Resolves when the manager has finished handling the batch, creds save included. */
    emit(events: Record<string, unknown>): Promise<void> {
      if (!handler) throw new Error('ev.process callback not registered');
      return handler(events);
    },
  };
}

/** Hand the loop back until `ready` holds. Bounded by turns, never by wall time. */
async function turnsUntil(ready: () => boolean, maxTurns = 200_000): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  throw new Error('condition not reached within the turn bound');
}

/** One check-phase turn, queued now; resolves only if the loop is free to run it. */
function loopProbe(): Promise<'fired'> {
  return new Promise((resolve) => { setImmediate(() => resolve('fired')); });
}

/** Read through the cached projection, so reading a record cannot itself walk the tree. */
function records(target: ConnectionManager, event: string): CredentialLifecycleEvent[] {
  return target.getHealthConnectionState().credentialLifecycle.recentEvents.filter(entry => entry.event === event);
}

function readBondEvents(): Array<Record<string, any>> {
  return readFileSync(join(testDataRoot, 'bond-events.ndjson'), 'utf-8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, any>);
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function credsHashPrefix(): string {
  return createHash('sha256').update(readFileSync(credsPath)).digest('hex').slice(0, 20);
}

/**
 * Connect a manager whose cache holds a completed walk, then open the socket.
 * Returns once the connection-open capture is parked on the capture valve.
 */
async function openWithHeldCapture() {
  writeValidAuth();
  const { mockSock, emit } = makeMockSocket();
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const created = new ConnectionManager();
  manager = created;
  const guard = internals(created).authBond;
  await created.connect();
  // A completed walk, so the open record has a digest to reuse.
  await guard.warmTreeCache();
  const startCaptureRun = vi.spyOn(guard as unknown as { startCaptureRun: (reason: string) => Promise<unknown> }, 'startCaptureRun');
  const inspect = vi.spyOn(guard, 'inspect');
  const drainBeforeOpen = syncDrain.requests;
  await emit({ 'connection.update': { connection: 'open' } });
  await turnsUntil(() => captureIo.calls > 0);
  const drainedDuringOpen = syncDrain.requests - drainBeforeOpen;
  // The open handler starts its own warm; let it publish before the test
  // drives anything else, so a later invalidation is not raced by it.
  await guard.warmTreeCache();
  return { manager: created, guard, emit, startCaptureRun, inspect, drainedDuringOpen };
}

beforeEach(() => {
  // Timers are fake so the 60 s settled-snapshot delay and the guard's refresh
  // successor run only when a test says so. Immediates stay real: they are
  // the turns a yielding capture hands back, and the probe below needs them.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  rmSync(testRoot, { recursive: true, force: true });
  syncDrain.requests = 0;
  captureIo.calls = 0;
  const valve = deferred<void>();
  captureIo.valve = valve.promise;
  captureIo.release = () => valve.resolve();
  authState.creds['registrationId'] = 1;
});

afterEach(async () => {
  captureIo.release();
  if (manager !== null) {
    const guard = internals(manager).authBond;
    await manager.shutdown();
    // A background walk still traversing the fixture would race its removal.
    await turnsUntil(() => guard.inspectCached().treeProvenance?.refreshInFlight !== true);
    manager = null;
  }
  vi.useRealTimers();
  rmSync(testRoot, { recursive: true, force: true });
});

usePerTestBotErrorsMarkerIsolation();

describe('#3677 routine lifecycle records reuse an observation', () => {
  it('records connection_open from the cached digest, without a synchronous tree walk, while the capture waits on slow I/O', async () => {
    const { manager, guard, inspect, drainedDuringOpen } = await openWithHeldCapture();

    // The loop is free: a turn queued now runs while the capture is still
    // parked on its first filesystem request.
    await expect(loopProbe()).resolves.toBe('fired');
    expect(guard.isCaptureInFlight()).toBe(true);
    expect(records(manager, 'auth_snapshot_captured')).toHaveLength(0);

    // No inline drain ran a single filesystem request on the open path —
    // record, bond event and runtime-state sidecar included.
    expect(drainedDuringOpen).toBe(0);
    expect(inspect).not.toHaveBeenCalled();

    const live = guard.inspect();
    const [open] = records(manager, 'connection_open');
    expect(open).toMatchObject({
      authBondStatus: 'present',
      authBondTreeSource: 'cached',
      treeHash: live.treeHash!.slice(0, 20),
    });
    expect(typeof open!.authBondTreeAgeMs).toBe('number');

    const bondEvent = readBondEvents().find(event => event.event === 'connection_open');
    expect(bondEvent?.auth.bond).toMatchObject({ treeSource: 'cached', status: 'present' });
    expect(typeof bondEvent?.auth.bond.treeAgeMs).toBe('number');

    const sidecar = JSON.parse(readFileSync(join(testDataRoot, 'connection-state.json'), 'utf-8')) as Record<string, any>;
    expect(sidecar['event']).toBe('connection_open');
    expect(sidecar['authBond']).toMatchObject({ treeSource: 'cached', status: 'present' });
  });

  it('records creds updates during a slow capture without a synchronous tree walk, and marks the digest stale', async () => {
    const { manager, guard, emit, inspect } = await openWithHeldCapture();

    const before = syncDrain.requests;
    authState.creds['registrationId'] = 2;
    await emit({ 'creds.update': {} });
    const savedHash = credsHashPrefix();
    const drained = syncDrain.requests - before;

    await expect(loopProbe()).resolves.toBe('fired');
    expect(guard.isCaptureInFlight()).toBe(true);
    expect(drained).toBe(0);
    expect(inspect).not.toHaveBeenCalled();

    // creds.json is read live, so the record names the bytes just saved. The
    // tree digest predates the save, and the record says so instead of
    // presenting it as current.
    const [saved] = records(manager, 'creds_update_saved');
    expect(saved).toMatchObject({ credsHash: savedHash, authBondTreeSource: 'stale' });
    expect(typeof saved!.authBondTreeAgeMs).toBe('number');
    const [scheduled] = records(manager, 'auth_snapshot_scheduled');
    expect(scheduled).toMatchObject({ authBondTreeSource: 'stale', note: 'creds-update-settled' });

    const sidecar = JSON.parse(readFileSync(join(testDataRoot, 'connection-state.json'), 'utf-8')) as Record<string, any>;
    expect(sidecar['event']).toBe('creds_update_saved');
    expect(sidecar['authBond']).toMatchObject({ credsHash: savedHash, treeSource: 'stale' });
  });

  it('coalesces two creds updates during one in-flight capture into one queued re-run that records the latest saved credentials', async () => {
    const { manager, guard, emit, startCaptureRun } = await openWithHeldCapture();
    const captureAsync = vi.spyOn(guard, 'captureAsync');

    authState.creds['registrationId'] = 2;
    await emit({ 'creds.update': {} });
    const firstHash = credsHashPrefix();
    authState.creds['registrationId'] = 3;
    await emit({ 'creds.update': {} });
    const latestHash = credsHashPrefix();
    expect(latestHash).not.toBe(firstHash);

    // The second update replaced the first one's settled-snapshot timer, so
    // one trigger fires. The open capture still holds the guard, so that
    // trigger queues the single re-run rather than starting a second capture:
    // the only run started so far is the open capture's.
    vi.advanceTimersByTime(60_000);
    expect(captureAsync).toHaveBeenCalledTimes(1);
    expect(startCaptureRun).toHaveBeenCalledTimes(1);
    expect(guard.isCaptureInFlight()).toBe(true);

    const saved = records(manager, 'creds_update_saved');
    expect(saved.map(entry => entry.credsHash)).toEqual([firstHash, latestHash]);
    expect(saved.map(entry => entry.authBondTreeSource)).toEqual(['stale', 'stale']);

    captureIo.release();
    await turnsUntil(() => records(manager, 'auth_snapshot_captured').length === 2 && !guard.isCaptureInFlight());

    // The queued re-run started only once the open capture settled: two runs
    // in all, never two at once.
    expect(startCaptureRun).toHaveBeenCalledTimes(2);
    const captured = records(manager, 'auth_snapshot_captured');
    for (const entry of captured) {
      expect(entry).toMatchObject({ credsHash: latestHash, authBondTreeSource: 'capture', authBondTreeAgeMs: 0 });
    }
    const latest = JSON.parse(readFileSync(latestPath, 'utf-8')) as { treeHash: string };
    expect(latest.treeHash).toBe(guard.inspect().treeHash);
  });

  it('cancelCaptures() during a slow capture leaves nothing pending and writes no capture record', async () => {
    const { manager, guard, startCaptureRun } = await openWithHeldCapture();
    const handled = internals(manager).authSnapshotCapture;
    expect(handled).not.toBeNull();
    const eventsBefore = manager.getHealthConnectionState().credentialLifecycle.recentEvents.length;
    const timersBefore = vi.getTimerCount();

    const cancelled = guard.cancelCaptures();
    // The parked request completes, and the abort lands at the next boundary.
    captureIo.release();
    await cancelled;
    await handled;

    expect(guard.isCaptureInFlight()).toBe(false);
    // Only the open capture ever ran; nothing was queued behind it.
    expect(startCaptureRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(entries(stagingRoot)).toEqual([]);
    expect(entries(historyRoot)).toEqual([]);
    expect(existsSync(latestPath)).toBe(false);

    // The cancelled capture recorded nothing, so no record claims a capture's
    // observation; the open record still names the cache it came from.
    const events = manager.getHealthConnectionState().credentialLifecycle.recentEvents;
    expect(events).toHaveLength(eventsBefore);
    expect(events.filter(entry => entry.event.startsWith('auth_snapshot_') && entry.event !== 'auth_snapshot_scheduled')).toEqual([]);
    expect(events.filter(entry => entry.authBondTreeSource === 'capture')).toEqual([]);
    expect(readBondEvents().filter(event => event.event === 'auth_snapshot_captured')).toEqual([]);
    expect(records(manager, 'connection_open').map(entry => entry.authBondTreeSource)).toEqual(['cached']);
  });
});
