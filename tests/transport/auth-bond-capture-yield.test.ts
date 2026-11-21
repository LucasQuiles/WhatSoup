// C8: the auth-bond capture hands the event loop back between bounded slices.
//
// Every interleaving below is driven through the guard's injected yield, sleep
// and event hooks, so none of these tests depends on wall-clock speed. The
// fixtures are real temporary folders. Test ids (N1-N11) match the C8 design
// note's test plan.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  AuthBondGuard,
  type AuthBondCaptureEvent,
  type AuthBondCaptureResult,
  type AuthBondRestoreResult,
} from '../../src/transport/auth-bond.ts';

type FsModule = typeof import('node:fs');
type StartedEvent = Extract<AuthBondCaptureEvent, { kind: 'started' }>;
type FinishedEvent = Extract<AuthBondCaptureEvent, { kind: 'finished' }>;

const tmp = trackTmpDirs('');

/** Neutral placeholder identity; the guard only hashes it. */
const IDENTITY = 'user-a:1@example.invalid';
/** Content marker of every key file; it must never reach a capture event. */
const KEY_CONTENT_MARKER = 'c8-yield-key-file-marker';
/** Enough files that every walk and the copy cross several slice boundaries. */
const KEY_FILES = 200;
const BLOCK_REASON = 'loggedOut/device-bond-lost state active';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.doUnmock('node:fs');
  vi.resetModules();
});

interface Fixture {
  readonly authDir: string;
  readonly stateRoot: string;
  readonly name: string;
}

function writeCreds(authDir: string): void {
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id: IDENTITY, lid: 'user-a-lid:1@example.invalid' },
    registrationId: 1,
  }));
}

function makeFixture(label: string, keyFiles = KEY_FILES): Fixture {
  const root = tmp.make(`whatsoup-auth-bond-yield-${label}`);
  const authDir = join(root, 'auth');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeCreds(authDir);
  for (let index = 0; index < keyFiles; index += 1) {
    writeFileSync(
      join(authDir, `pre-key-${String(index).padStart(4, '0')}.json`),
      JSON.stringify({ keyData: `${KEY_CONTENT_MARKER}-${index}` }),
    );
  }
  return { authDir, stateRoot: join(root, 'state'), name: `yield-${label}-bot` };
}

function backupRoot(fx: Fixture): string {
  return join(fx.stateRoot, 'auth-bond-backups', fx.name);
}

function latestPath(fx: Fixture): string {
  return join(backupRoot(fx), 'latest.json');
}

function listOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function historyEntries(fx: Fixture): string[] {
  return listOrEmpty(join(backupRoot(fx), 'history'));
}

function stagingEntries(fx: Fixture): string[] {
  return listOrEmpty(join(backupRoot(fx), 'staging'));
}

/** Files already copied into a staging folder: non-zero once the copy has started. */
function stagedFileCount(fx: Fixture): number {
  let count = 0;
  for (const entry of stagingEntries(fx)) {
    count += listOrEmpty(join(backupRoot(fx), 'staging', entry, 'auth')).length;
  }
  return count;
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function startedEvents(events: readonly AuthBondCaptureEvent[]): StartedEvent[] {
  return events.filter((event): event is StartedEvent => event.kind === 'started');
}

function finishedEvents(events: readonly AuthBondCaptureEvent[]): FinishedEvent[] {
  return events.filter((event): event is FinishedEvent => event.kind === 'finished');
}

function keyData(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf8')) as { keyData?: unknown }).keyData;
}

/**
 * Import the guard with every synchronous fs call counted. Only `*Sync`
 * functions are wrapped, because the capture path uses no other kind.
 */
async function importGuardCountingFs(counter: { ops: number }) {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<FsModule>();
    const counted: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(actual)) {
      if (typeof value !== 'function' || !name.endsWith('Sync')) continue;
      const original = value as (...args: unknown[]) => unknown;
      counted[name] = (...args: unknown[]) => {
        counter.ops += 1;
        return original(...args);
      };
    }
    return { ...actual, ...counted };
  });
  return import('../../src/transport/auth-bond.ts');
}

describe('C8: the auth-bond capture hands the event loop back', () => {
  it('N1: returns before doing capture work and lets the loop run during the capture', async () => {
    const fx = makeFixture('n1');
    let yields = 0;
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: async () => {
        yields += 1;
        await macrotask();
      },
    });
    const progress: {
      settled: boolean;
      observer: { latest: boolean; settled: boolean } | null;
    } = { settled: false, observer: null };

    const pending = Promise.resolve(guard.capture('connection-open')).then((result) => {
      progress.settled = true;
      return result;
    });
    // Nothing is published inside the caller's synchronous turn.
    expect(existsSync(latestPath(fx))).toBe(false);
    setImmediate(() => {
      progress.observer = { latest: existsSync(latestPath(fx)), settled: progress.settled };
    });
    await Promise.resolve();
    expect(progress.settled).toBe(false);

    const result = await pending;

    // A macrotask queued after the call ran while the capture was still open.
    expect(progress.observer).toEqual({ latest: false, settled: false });
    expect(result).toMatchObject({ ok: true, captured: true });
    expect(existsSync(latestPath(fx))).toBe(true);
    expect(yields).toBeGreaterThanOrEqual(10);
  });

  it('N2: bounds the synchronous fs work between two yields', async () => {
    const fx = makeFixture('n2', 300);
    const counter = { ops: 0 };
    const counted = await importGuardCountingFs(counter);
    let yields = 0;
    let maxOpsBetweenYields = 0;
    const guard = new counted.AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: async () => {
        maxOpsBetweenYields = Math.max(maxOpsBetweenYields, counter.ops);
        counter.ops = 0;
        yields += 1;
        await macrotask();
      },
    });

    counter.ops = 0;
    const result = await guard.capture('connection-open');
    maxOpsBetweenYields = Math.max(maxOpsBetweenYields, counter.ops);

    expect(result).toMatchObject({ ok: true, captured: true });
    expect(yields).toBeGreaterThanOrEqual(10);
    // One slice holds at most a few dozen entries of one or two tree steps.
    // The capture of this 301-file tree makes thousands of fs calls in total,
    // so a single unsliced run is an order of magnitude over this bound.
    expect(maxOpsBetweenYields).toBeLessThanOrEqual(400);
  });

  it('N3: a tree change during the copy never yields a backup of a tree that did not exist', async () => {
    const fx = makeFixture('n3');
    const firstPath = join(fx.authDir, 'app-state-sync-key-0000.json');
    const lastPath = join(fx.authDir, 'session-zzzz.json');
    writeFileSync(firstPath, JSON.stringify({ keyData: 'first-old' }));
    writeFileSync(lastPath, JSON.stringify({ keyData: 'last-old' }));
    const state = { mutated: false };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      captureYield: async () => {
        if (!state.mutated && stagedFileCount(fx) > 0) {
          // Both files change in one synchronous step, so a backup holding one
          // old and one new file would describe a tree that never existed.
          writeFileSync(firstPath, JSON.stringify({ keyData: 'first-new' }));
          writeFileSync(lastPath, JSON.stringify({ keyData: 'last-new' }));
          state.mutated = true;
        }
        await macrotask();
      },
    });
    const hashBefore = guard.inspect().treeHash;

    const result = await guard.capture('connection-open');

    // Coverage: the change landed inside the run, after the copy had started.
    expect(state.mutated).toBe(true);
    const hashAfter = guard.inspect().treeHash;
    expect(result).toMatchObject({ ok: true, captured: true });
    const backedUp = [
      keyData(join(result.path!, 'auth', 'app-state-sync-key-0000.json')),
      keyData(join(result.path!, 'auth', 'session-zzzz.json')),
    ];
    expect([['first-old', 'last-old'], ['first-new', 'last-new']]).toContainEqual(backedUp);
    const manifest = JSON.parse(readFileSync(join(result.path!, 'manifest.json'), 'utf8')) as {
      treeHash?: string;
    };
    expect([hashBefore, hashAfter]).toContain(manifest.treeHash);
    expect(historyEntries(fx)).toHaveLength(1);
    expect(stagingEntries(fx)).toEqual([]);
  });

  it('N4: requests during a run fold into one trailing run, and none is dropped', async () => {
    const fx = makeFixture('n4');
    const events: AuthBondCaptureEvent[] = [];
    const lateFile = join(fx.authDir, 'session-late-change.json');
    const pending: { b?: Promise<AuthBondCaptureResult>; c?: Promise<AuthBondCaptureResult> } = {};
    const guard: AuthBondGuard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: async () => {
        if (pending.b === undefined && stagedFileCount(fx) > 0) {
          writeFileSync(lateFile, JSON.stringify({ keyData: 'late' }));
          pending.b = guard.capture('settled-b');
          pending.c = guard.capture('settled-c');
        }
        await macrotask();
      },
    });

    const first = await guard.capture('connection-open');

    // Coverage: both requests were made while run 1 was open.
    expect(pending.b).toBeDefined();
    expect(pending.c).toBeDefined();
    const [b, c] = await Promise.all([pending.b!, pending.c!]);
    expect(b).toBe(c);
    expect(first).toMatchObject({ ok: true, captured: true });
    expect(b).toMatchObject({ ok: true, captured: true });
    // The trailing run started after the change its requests were made for.
    expect(existsSync(join(b.path!, 'auth', 'session-late-change.json'))).toBe(true);
    // Strictly one run at a time.
    expect(events.map((event) => `${event.kind}:${event.run}`)).toEqual([
      'started:1',
      'finished:1',
      'started:2',
      'finished:2',
    ]);
    expect(startedEvents(events)[1]).toMatchObject({
      run: 2,
      reason: 'settled-c',
      coalescedRequests: 2,
    });
    expect(historyEntries(fx)).toHaveLength(2);
  });

  it('N5: a block reason that appears during the run stops the publish', async () => {
    const fx = makeFixture('n5');
    const state: { block: string | null; armed: boolean } = { block: null, armed: false };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureBlockReason: () => state.block,
      captureYield: async () => {
        if (state.armed && state.block === null && stagedFileCount(fx) > 0) {
          state.block = BLOCK_REASON;
        }
        await macrotask();
      },
    });
    const seed = await guard.capture('connection-open');
    expect(seed).toMatchObject({ ok: true, captured: true });
    const latestBefore = readFileSync(latestPath(fx), 'utf8');
    writeFileSync(join(fx.authDir, 'session-after-seed.json'), JSON.stringify({ keyData: 'after-seed' }));
    state.armed = true;

    const result = await guard.capture('creds-update');

    // Coverage: the block reason appeared after the copy had started.
    expect(state.block).toBe(BLOCK_REASON);
    expect(result).toMatchObject({
      ok: false,
      captured: false,
      deferred: false,
      blocked: true,
      path: null,
    });
    expect(result.error).toContain(`auth bond capture blocked: ${BLOCK_REASON}`);
    expect(readFileSync(latestPath(fx), 'utf8')).toBe(latestBefore);
    expect(historyEntries(fx)).toHaveLength(1);
    expect(stagingEntries(fx)).toEqual([]);
  });

  it('N6: a restore aborts an in-flight capture before the capture reads the live tree again', async () => {
    const fx = makeFixture('n6');
    const state: { armed: boolean; restore: AuthBondRestoreResult | null } = {
      armed: false,
      restore: null,
    };
    const guard: AuthBondGuard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: async () => {
        if (state.armed && state.restore === null && stagedFileCount(fx) > 0) {
          // A definite, non-transient fault: a credential object with no identity.
          writeFileSync(join(fx.authDir, 'creds.json'), JSON.stringify({ registrationId: 9 }));
          state.restore = guard.restoreLatestIfNeeded();
        }
        await macrotask();
      },
    });
    const seed = await guard.capture('connection-open');
    expect(seed).toMatchObject({ ok: true, captured: true });
    const latestBefore = readFileSync(latestPath(fx), 'utf8');
    writeFileSync(join(fx.authDir, 'session-after-seed.json'), JSON.stringify({ keyData: 'after-seed' }));
    state.armed = true;

    const result = await guard.capture('creds-update');

    // Coverage: the restore ran inside the run and replaced the live tree.
    expect(state.restore).toMatchObject({ attempted: true, restored: true });
    expect(result).toMatchObject({ ok: false, captured: false, aborted: true, path: null });
    expect(readFileSync(latestPath(fx), 'utf8')).toBe(latestBefore);
    expect(historyEntries(fx)).toHaveLength(1);
    expect(stagingEntries(fx)).toEqual([]);
    const liveCreds = JSON.parse(readFileSync(join(fx.authDir, 'creds.json'), 'utf8')) as {
      me?: { id?: string };
    };
    expect(liveCreds.me?.id).toBe(IDENTITY);
    expect(existsSync(join(fx.authDir, 'session-after-seed.json'))).toBe(false);
  });

  it('N7a: shutdown settles an in-flight run without another yield and refuses later requests', async () => {
    const fx = makeFixture('n7a');
    const events: AuthBondCaptureEvent[] = [];
    const state: { yields: number; yieldsAtShutdown: number | null; shutdown: Promise<void> | null } = {
      yields: 0,
      yieldsAtShutdown: null,
      shutdown: null,
    };
    const guard: AuthBondGuard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: async () => {
        state.yields += 1;
        if (state.shutdown === null && stagedFileCount(fx) > 0) {
          state.yieldsAtShutdown = state.yields;
          state.shutdown = guard.shutdownCaptures();
        }
        await macrotask();
      },
    });

    const result = await guard.capture('connection-open');
    await state.shutdown;

    // Coverage: shutdown was requested while the copy was in progress.
    expect(state.yieldsAtShutdown).not.toBeNull();
    expect(state.yields).toBe(state.yieldsAtShutdown);
    expect(result).toMatchObject({ ok: false, captured: false, aborted: true, path: null });
    expect(existsSync(latestPath(fx))).toBe(false);
    expect(historyEntries(fx)).toEqual([]);

    const later = await guard.capture('after-shutdown');
    expect(later).toMatchObject({ ok: false, captured: false, aborted: true, path: null });
    expect(later.error).toContain('shutting down');
    expect(startedEvents(events)).toHaveLength(1);
  });

  it('N7b: shutdown settles a parked run without any timer firing', async () => {
    vi.useFakeTimers();
    const fx = makeFixture('n7b');
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
    });

    // The default yield is a faked setImmediate, so the run parks at its first
    // yield; nothing advances the fake clock below.
    const run = guard.capture('connection-open');
    await guard.shutdownCaptures();
    const result = await run;

    expect(result).toMatchObject({ ok: false, captured: false, aborted: true });
    expect(existsSync(latestPath(fx))).toBe(false);
  });

  it('N8: waits between attempts through the injected sleep, never through Atomics.wait', async () => {
    const root = tmp.make('whatsoup-auth-bond-yield-n8');
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), '');
    const wait = vi.spyOn(Atomics, 'wait');
    const sleeps: number[] = [];
    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'yield-n8-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 75,
      freshInvalidGraceMs: 60_000,
      captureSleep: async (ms) => {
        sleeps.push(ms);
        // The credential write settles while the capture waits.
        writeCreds(authDir);
      },
    });

    const result = await guard.capture('creds-update');

    expect(result).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(result.path).toEqual(expect.any(String));
    expect(sleeps).toEqual([75]);
    expect(wait).not.toHaveBeenCalled();
    expect(guard.inspect().backup.lastCaptureError).toBeNull();
  });

  it('N9: reports each run as started then finished, with elapsed time and no key contents', async () => {
    const fx = makeFixture('n9');
    const clock = { value: 1_000 };
    const events: AuthBondCaptureEvent[] = [];
    const clockAtEvent: number[] = [];
    let yields = 0;
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      monotonicNow: () => clock.value,
      captureYield: async () => {
        yields += 1;
        clock.value += 7;
        await macrotask();
      },
      onCaptureEvent: (event) => {
        events.push(event);
        clockAtEvent.push(clock.value);
      },
    });

    const result = await guard.capture('connection-open');

    expect(result).toMatchObject({ ok: true, captured: true });
    expect(events.map((event) => event.kind)).toEqual(['started', 'finished']);
    const started = startedEvents(events)[0];
    const finished = finishedEvents(events)[0];
    expect(started).toMatchObject({
      kind: 'started',
      run: 1,
      reason: 'connection-open',
      coalescedRequests: 1,
      queuedMs: 0,
    });
    expect(finished).toMatchObject({
      kind: 'finished',
      run: 1,
      reason: 'connection-open',
      outcome: 'captured',
      attempts: 1,
      error: null,
      consecutiveDeferrals: 0,
      fileCount: KEY_FILES + 1,
    });
    expect(finished!.elapsedMs).toBe(clockAtEvent[1]! - clockAtEvent[0]!);
    expect(finished!.elapsedMs).toBeGreaterThan(0);
    expect(finished!.slices).toBe(yields);
    // The stepping clock moves only inside captureYield, and handing the loop
    // back is not slice time, so every slice measures 0 on this clock.
    expect(finished!.maxSliceMs).toBe(0);
    expect(Object.keys(finished!.phaseMs).sort()).toEqual([
      'copy',
      'inspect',
      'prune',
      'publish',
      'sweep',
      'validate',
    ]);
    expect(finished!.totalBytes).toBeGreaterThan(0);

    const unchanged = await guard.capture('creds-update-settled');
    expect(unchanged).toMatchObject({ ok: true, captured: false });
    expect(finishedEvents(events)[1]).toMatchObject({
      run: 2,
      outcome: 'unchanged',
      consecutiveDeferrals: 0,
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(KEY_CONTENT_MARKER);
    expect(serialized).not.toContain(IDENTITY);
    expect(serialized).not.toContain(guard.inspect().treeHash!);
    expect(serialized).not.toContain('auth-bond-backups');
  });

  it('N10: never rejects; a throw inside the run becomes a failed result', async () => {
    const fx = makeFixture('n10');
    let calls = 0;
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: async () => {
        calls += 1;
        if (calls === 3) throw new Error('injected yield failure');
        await macrotask();
      },
    });

    const result = await guard.capture('connection-open');

    // Coverage: the failing yield was reached.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('injected yield failure');
    expect(existsSync(latestPath(fx))).toBe(false);
    expect(historyEntries(fx)).toEqual([]);
  });

  it('N11: counts consecutive deferred runs, ignores blocked runs, and resets on a capture', async () => {
    const root = tmp.make('whatsoup-auth-bond-yield-n11');
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), '');
    const events: AuthBondCaptureEvent[] = [];
    const state: { block: string | null } = { block: null };
    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'yield-n11-bot',
      captureAttempts: 1,
      freshInvalidGraceMs: 60_000,
      captureBlockReason: () => state.block,
      onCaptureEvent: (event) => { events.push(event); },
    });

    expect(await guard.capture('deferred-1')).toMatchObject({ deferred: true });
    state.block = BLOCK_REASON;
    expect(await guard.capture('blocked-1')).toMatchObject({ blocked: true });
    state.block = null;
    expect(await guard.capture('deferred-2')).toMatchObject({ deferred: true });
    writeCreds(authDir);
    expect(await guard.capture('captured-1')).toMatchObject({ ok: true, captured: true });

    expect(finishedEvents(events).map((event) => [event.outcome, event.consecutiveDeferrals])).toEqual([
      ['deferred', 1],
      ['blocked', 1],
      ['deferred', 2],
      ['captured', 0],
    ]);
  });
});

// ── C8 FIX 2: vanished entries, settling, and slice timing ───────────────────
//
// Test ids N12-N14 match the "FIX 2" section of the C8 design note: N12 is
// F2-4, N13 is F2-3, N14 is F2-6. The F2-1 budget tests live in
// auth-bond-capture-budget.test.ts, and the connection-level ones in
// reconnect.test.ts.

/** A creds saver temp file: valid creds with the same identity and different bytes. */
const CREDS_TEMP = '.creds.json.4242.c8-temp.tmp';
/** F2-4: every incomplete-read deferral's error text contains this. */
const INCOMPLETE_READ_DEFERRAL = 'auth bond auth tree read was incomplete';
/** F2-4: the bound's failure, on the seventh consecutive incomplete-read run. */
const INCOMPLETE_READ_BOUND_FAILURE = 'auth bond auth tree read was incomplete in 7 consecutive runs';
const IN_SLICE_MS = 13;
const RETRY_DELAY_MS = 75;
const PENDING = Symbol('pending');

function keyPath(fx: Fixture, index: number): string {
  return join(fx.authDir, `pre-key-${String(index).padStart(4, '0')}.json`);
}

function writeCredsTemp(fx: Fixture): string {
  const path = join(fx.authDir, CREDS_TEMP);
  writeFileSync(path, JSON.stringify({
    me: { id: IDENTITY, lid: 'user-a-lid:1@example.invalid' },
    registrationId: 2,
  }));
  return path;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Names already copied into any staging folder. */
function stagedNames(fx: Fixture): string[] {
  return stagingEntries(fx).flatMap((entry) => listOrEmpty(join(backupRoot(fx), 'staging', entry, 'auth')));
}

/** Waits a bounded number of loop turns, never a wall-clock time, for a promise to settle. */
async function settledWithin<T>(promise: Promise<T>, turns = 200): Promise<T | typeof PENDING> {
  const box: { settled: boolean; value: T | null } = { settled: false, value: null };
  void promise.then((value) => {
    box.settled = true;
    box.value = value;
  });
  for (let turn = 0; turn < turns && !box.settled; turn += 1) await macrotask();
  return box.settled ? box.value as T : PENDING;
}

/**
 * A yield hook that runs one pending mutation inside the tree walk, after the
 * walk has listed the folder and before it has read the files listed late.
 * The sentinel sorts after every other entry, so the harden walk repairs its
 * mode last. The first yield that sees it repaired can still come before the
 * walk lists the folder, so the mutation runs at the yield after that one.
 */
function midWalkYield(sentinel: string, state: { pending: (() => void) | null; fired: number }) {
  let repairedSeen = false;
  return async (): Promise<void> => {
    if (state.pending !== null) {
      if (repairedSeen) {
        const mutate = state.pending;
        state.pending = null;
        repairedSeen = false;
        state.fired += 1;
        mutate();
      } else if (modeOf(sentinel) === 0o600) {
        repairedSeen = true;
      }
    }
    await macrotask();
  };
}

describe('C8 FIX 2: vanished entries, settling, and slice timing', () => {
  it('N12a: an entry that vanishes mid-walk defers the run; the next run captures and nothing fails', async () => {
    const fx = makeFixture('n12a');
    const tempPath = writeCredsTemp(fx);
    const sentinel = keyPath(fx, KEY_FILES - 1);
    const deleted = keyPath(fx, 150);
    const events: AuthBondCaptureEvent[] = [];
    const state: { pending: (() => void) | null; fired: number } = { pending: null, fired: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      // One attempt per run, so the vanish decides how the run ends.
      captureAttempts: 1,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: midWalkYield(sentinel, state),
    });

    // Run 1: a key file the walk has listed is deleted before the walk reads it.
    chmodSync(sentinel, 0o644);
    state.pending = () => { unlinkSync(deleted); };
    const keyRun = await guard.capture('connection-open');
    // Run 2: the creds saver renames its temp file away after the walk listed it.
    chmodSync(sentinel, 0o644);
    state.pending = () => { renameSync(tempPath, join(fx.authDir, 'creds.json')); };
    const tempRun = await guard.capture('creds-update-settled');
    // Run 3: the owed request, on a quiet tree.
    const owed = await guard.capture('auth-bond-capture-deferred');

    // Coverage: both mutations landed inside their runs.
    expect(state.fired).toBe(2);
    expect(existsSync(deleted)).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
    for (const result of [keyRun, tempRun]) {
      expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
      expect(result.error).toContain(INCOMPLETE_READ_DEFERRAL);
    }
    expect(owed).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(existsSync(join(owed.path!, 'auth', basename(deleted)))).toBe(false);
    expect(finishedEvents(events).map((event) => event.outcome)).toEqual(['deferred', 'deferred', 'captured']);
    // Nothing failed: no failure reached the guard's health fields.
    expect(guard.inspect().backup.lastCaptureError).toBeNull();
    expect(historyEntries(fx)).toHaveLength(1);
    expect(stagingEntries(fx)).toEqual([]);
  });

  it('N12b: entries that vanish mid-copy defer the run; the next run captures and nothing fails', async () => {
    const fx = makeFixture('n12b');
    const tempPath = writeCredsTemp(fx);
    const events: AuthBondCaptureEvent[] = [];
    const state: { armed: boolean; deleted: string | null; renamed: boolean } = {
      armed: true,
      deleted: null,
      renamed: false,
    };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureAttempts: 1,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: async () => {
        if (state.armed && stagedFileCount(fx) > 0) {
          state.armed = false;
          // A key file the copy has listed but not reached yet, then the temp
          // file renamed over creds.json.
          const staged = new Set(stagedNames(fx));
          const unstaged = readdirSync(fx.authDir)
            .filter((name) => name.startsWith('pre-key-') && !staged.has(name))
            .sort();
          state.deleted = join(fx.authDir, unstaged[unstaged.length - 1]!);
          unlinkSync(state.deleted);
          renameSync(tempPath, join(fx.authDir, 'creds.json'));
          state.renamed = true;
        }
        await macrotask();
      },
    });

    const result = await guard.capture('connection-open');
    const owed = await guard.capture('auth-bond-capture-deferred');

    // Coverage: both mutations landed after the copy had started.
    expect(state.deleted).not.toBeNull();
    expect(state.renamed).toBe(true);
    // The copy skips the vanished entries; validation then finds a tree that
    // changed with the same identity, and that defers.
    expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
    expect(result.error).toContain('changed during capture with the same identity');
    expect(owed).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(existsSync(join(owed.path!, 'auth', basename(state.deleted!)))).toBe(false);
    expect(finishedEvents(events).map((event) => event.outcome)).toEqual(['deferred', 'captured']);
    expect(guard.inspect().backup.lastCaptureError).toBeNull();
    expect(historyEntries(fx)).toHaveLength(1);
    expect(stagingEntries(fx)).toEqual([]);
  });

  it('N12c: six consecutive incomplete-read deferrals, then the seventh fails; another ending resets the count', async () => {
    const fx = makeFixture('n12c');
    const sentinel = keyPath(fx, KEY_FILES - 1);
    const events: AuthBondCaptureEvent[] = [];
    const state: { pending: (() => void) | null; fired: number } = { pending: null, fired: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureAttempts: 1,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: midWalkYield(sentinel, state),
    });
    let victim = 100;
    const vanishRun = async (reason: string): Promise<AuthBondCaptureResult> => {
      const path = keyPath(fx, victim);
      victim += 1;
      chmodSync(sentinel, 0o644);
      state.pending = () => { unlinkSync(path); };
      const result = await guard.capture(reason);
      expect(state.pending, `the vanish landed inside ${reason}`).toBeNull();
      return result;
    };

    // Three incomplete reads, then a run that ends otherwise.
    for (let run = 1; run <= 3; run += 1) {
      const result = await vanishRun(`settled-${run}`);
      expect(result).toMatchObject({ ok: false, deferred: true });
      expect(result.error).toContain(INCOMPLETE_READ_DEFERRAL);
    }
    expect(await guard.capture('quiet')).toMatchObject({ ok: true, captured: true });
    // The count restarted, so six more incomplete reads still defer...
    for (let run = 4; run <= 9; run += 1) {
      const result = await vanishRun(`settled-${run}`);
      expect(result).toMatchObject({ ok: false, deferred: true });
      expect(result.error).toContain(INCOMPLETE_READ_DEFERRAL);
    }
    // ...and the seventh consecutive one fails, which pages through
    // connection.ts as an incomplete read did on main.
    const bound = await vanishRun('settled-10');

    expect(state.fired).toBe(10);
    expect(bound).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(bound.error).toContain(INCOMPLETE_READ_BOUND_FAILURE);
    expect(guard.inspect().backup.lastCaptureError).toBe(bound.error);
    expect(finishedEvents(events).map((event) => event.outcome)).toEqual([
      'deferred', 'deferred', 'deferred', 'captured',
      'deferred', 'deferred', 'deferred', 'deferred', 'deferred', 'deferred',
      'failed',
    ]);
  });

  it('N13: a run whose failure result cannot be built still settles, and later requests start new runs', async () => {
    const fx = makeFixture('n13', 4);
    mkdirSync(backupRoot(fx), { recursive: true, mode: 0o700 });
    // A truthy non-string backupPath passes the manifest's object check, and
    // every read of the backup half then throws (path.resolve of a number),
    // including the read that builds the failure result. inspect() reads it
    // too, so this test never calls inspect().
    writeFileSync(latestPath(fx), JSON.stringify({ backupPath: 42, treeHash: 'c8-not-a-tree-hash' }));
    const events: AuthBondCaptureEvent[] = [];
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
    });

    const first = guard.capture('connection-open');
    // Made while run 1 is active, so it folds into the trailing run.
    const trailing = guard.capture('creds-update-settled');
    const firstResult = await settledWithin(first);
    const trailingResult = await settledWithin(trailing);

    expect(firstResult, 'run 1 never settled').not.toBe(PENDING);
    expect(firstResult).toMatchObject({
      ok: false,
      captured: false,
      deferred: false,
      path: null,
      error: expect.any(String),
    });
    expect(trailingResult, 'the trailing run never settled').not.toBe(PENDING);
    expect(trailingResult).toMatchObject({ ok: false, captured: false, deferred: false, path: null });

    // With the metadata repaired, a later request starts a run that captures.
    rmSync(latestPath(fx));
    const repaired = await settledWithin(guard.capture('auth-bond-capture-deferred'));
    expect(repaired).toMatchObject({ ok: true, captured: true });
    expect(startedEvents(events).map((event) => event.run)).toEqual([1, 2, 3]);
    expect(finishedEvents(events).map((event) => [event.run, event.outcome])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'captured'],
    ]);
    expect(await settledWithin(guard.shutdownCaptures()), 'shutdownCaptures never resolved').not.toBe(PENDING);
  });

  it('N14a: maxSliceMs measures a clock advance inside a slice', async () => {
    const fx = makeFixture('n14a', 4);
    const clock = { value: 2_000 };
    const events: AuthBondCaptureEvent[] = [];
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      monotonicNow: () => clock.value,
      captureYield: async () => { await macrotask(); },
      // Synchronous capture work after a yield has returned: each block check
      // (at the start and in the publish turn) takes IN_SLICE_MS on this clock.
      captureBlockReason: () => {
        clock.value += IN_SLICE_MS;
        return null;
      },
      onCaptureEvent: (event) => { events.push(event); },
    });

    const result = await guard.capture('connection-open');

    expect(result).toMatchObject({ ok: true, captured: true });
    const finished = finishedEvents(events)[0]!;
    // Coverage: both block checks ran inside the run.
    expect(finished.elapsedMs).toBeGreaterThanOrEqual(2 * IN_SLICE_MS);
    expect(finished.maxSliceMs).toBeGreaterThanOrEqual(IN_SLICE_MS);
  });

  it('N14b: a retried run reports a longest slice below its retry delay', async () => {
    const root = tmp.make('whatsoup-auth-bond-yield-n14b');
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), '');
    const clock = { value: 3_000 };
    const events: AuthBondCaptureEvent[] = [];
    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'yield-n14b-bot',
      captureAttempts: 2,
      captureRetryDelayMs: RETRY_DELAY_MS,
      freshInvalidGraceMs: 60_000,
      monotonicNow: () => clock.value,
      captureYield: async () => { await macrotask(); },
      captureSleep: async (ms) => {
        // The whole delay passes on the injected clock while the run waits,
        // and the credential write settles.
        clock.value += ms;
        writeCreds(authDir);
      },
      captureBlockReason: () => {
        clock.value += IN_SLICE_MS;
        return null;
      },
      onCaptureEvent: (event) => { events.push(event); },
    });

    const result = await guard.capture('creds-update');

    expect(result).toMatchObject({ ok: true, captured: true });
    const finished = finishedEvents(events)[0]!;
    // Coverage: the run retried once, and its slices measured work.
    expect(finished.attempts).toBe(2);
    expect(finished.maxSliceMs).toBeGreaterThanOrEqual(IN_SLICE_MS);
    // The retry sleep is not synchronous capture work.
    expect(finished.maxSliceMs).toBeLessThan(RETRY_DELAY_MS);
  });
});

// ── C8 FIX 3: restore copies strictly, and a capture result cannot throw ─────
//
// Test ids N15-N17 are the fix round 3 tests. N15 and N16 wrap copyFileSync so
// that a key file the copy has listed vanishes before the copy reaches it:
// restore must fail and roll back, where the capture defers. N17 drives a
// capture hook that rejects with a value whose string conversion throws.

/** No prototype, so no toString or valueOf: String() of it throws a TypeError. */
const NO_STRING_FORM: unknown = Object.create(null);
/** The fixed text a capture result records for a thrown value with no string form. */
const NO_STRING_FORM_ERROR = 'thrown value has no string form';

interface CopyHook {
  beforeCopy: ((src: string, dest: string) => void) | null;
}

/** Import the guard with copyFileSync wrapped: while `hook.beforeCopy` is set, it runs before each copy. */
async function importGuardWithCopyHook(hook: CopyHook) {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<FsModule>();
    const copyFileSync: FsModule['copyFileSync'] = (src, dest, mode) => {
      hook.beforeCopy?.(String(src), String(dest));
      actual.copyFileSync(src, dest, mode);
    };
    return { ...actual, copyFileSync };
  });
  return import('../../src/transport/auth-bond.ts');
}

/**
 * A copy hook that, on the first copy into a destination `isTarget` accepts,
 * removes another key file from the source folder. At that copy the folder is
 * listed and only the file being copied is reached, so the removed file is
 * listed but not reached.
 */
function vanishOnFirstCopy(isTarget: (dest: string) => boolean, state: { vanished: string | null }) {
  return (src: string, dest: string): void => {
    if (state.vanished !== null || !isTarget(dest)) return;
    const dir = dirname(src);
    const victim = readdirSync(dir)
      .filter((name) => name.startsWith('pre-key-') && name !== basename(src))
      .sort()[0]!;
    state.vanished = join(dir, victim);
    unlinkSync(state.vanished);
  };
}

/** Every file of a flat folder, by name, with its contents. */
function flatTree(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

/** Drop treeHash from a backup JSON file, as written before manifests recorded one. */
function dropTreeHash(path: string): void {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  expect(typeof parsed['treeHash'], `${basename(path)} recorded a treeHash`).toBe('string');
  delete parsed['treeHash'];
  writeFileSync(path, JSON.stringify(parsed));
}

/** A captureYield whose first call rejects with `value`; later calls yield a macrotask. */
function firstYieldRejects(value: unknown): () => Promise<void> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw value;
    await macrotask();
  };
}

describe('C8 FIX 3: restore copies strictly, and a capture result cannot throw', () => {
  it('N15: a backup entry that vanishes during the restore copy fails the restore, which rolls back', async () => {
    const fx = makeFixture('n15', 4);
    const restoreTmp = `${fx.authDir}.restore-${process.pid}`;
    const hook: CopyHook = { beforeCopy: null };
    const { AuthBondGuard: HookedGuard } = await importGuardWithCopyHook(hook);
    const guard = new HookedGuard({ authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: fx.name });
    const seed = await guard.capture('connection-open');
    expect(seed).toMatchObject({ ok: true, captured: true });
    // A backup from before manifests recorded a tree hash. Restore's
    // validation then checks creds.json and the identity, not the whole tree,
    // so only the copy itself can notice the vanished entry.
    dropTreeHash(join(seed.path!, 'manifest.json'));
    dropTreeHash(latestPath(fx));
    // A definite fault, so the restore runs.
    writeFileSync(join(fx.authDir, 'creds.json'), '{ bad json');
    const liveBefore = flatTree(fx.authDir);
    const state: { vanished: string | null } = { vanished: null };
    hook.beforeCopy = vanishOnFirstCopy((dest) => dirname(dest) === restoreTmp, state);

    const restored = guard.restoreLatestIfNeeded();

    // Coverage: a listed backup key file vanished during the restore copy.
    expect(state.vanished).not.toBeNull();
    expect(restored).toMatchObject({ attempted: true, restored: false, source: seed.path });
    expect(flatTree(fx.authDir)).toEqual(liveBefore);
    expect(restored.error).toContain('ENOENT');
    expect(restored.error).toContain(basename(state.vanished!));
    expect(restored.error).toContain('quarantine=');
    expect(existsSync(restoreTmp)).toBe(false);
  });

  it('N16: control: an entry that vanishes during the capture copy still defers the capture', async () => {
    const fx = makeFixture('n16', 4);
    const state: { vanished: string | null } = { vanished: null };
    const hook: CopyHook = { beforeCopy: vanishOnFirstCopy((dest) => dest.includes(`.tmp-${process.pid}`), state) };
    const { AuthBondGuard: HookedGuard } = await importGuardWithCopyHook(hook);
    const guard = new HookedGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      // One attempt, so the deferral is the run's result: a second attempt
      // would copy the shorter tree completely and capture it.
      captureAttempts: 1,
    });

    const result = await guard.capture('connection-open');
    const owed = await guard.capture('auth-bond-capture-deferred');

    // Coverage: a listed key file vanished during the capture copy.
    expect(state.vanished).not.toBeNull();
    // The capture's copy skips it. Validation then finds a tree that changed
    // with the same identity, and that defers.
    expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
    expect(result.error).toContain('changed during capture with the same identity');
    expect(owed).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(existsSync(join(owed.path!, 'auth', basename(state.vanished!)))).toBe(false);
    expect(historyEntries(fx)).toHaveLength(1);
    expect(stagingEntries(fx)).toEqual([]);
  });

  it('N17a: a hook rejection with no string form settles the run as failed, and shutdown completes', async () => {
    const fx = makeFixture('n17a', 4);
    const events: AuthBondCaptureEvent[] = [];
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
      // The run's first yield is outside the attempt's own catch, so the
      // value reaches the failure result builder exactly as the hook threw it.
      captureYield: firstYieldRejects(NO_STRING_FORM),
    });
    // Coverage: the value's string conversion throws, as in errorMessage().
    expect(() => String(NO_STRING_FORM)).toThrow(TypeError);

    const result = await settledWithin(guard.capture('connection-open'));
    const shutdown = await settledWithin(guard.shutdownCaptures());

    expect(result, 'the run never settled').not.toBe(PENDING);
    expect(shutdown, 'shutdownCaptures never resolved').not.toBe(PENDING);
    expect(result).toMatchObject({
      ok: false,
      captured: false,
      deferred: false,
      path: null,
      error: NO_STRING_FORM_ERROR,
    });
    expect(finishedEvents(events).map((event) => [event.run, event.outcome, event.error])).toEqual([
      [1, 'failed', NO_STRING_FORM_ERROR],
    ]);
    expect(guard.inspect().backup.lastCaptureError).toBe(NO_STRING_FORM_ERROR);
    expect(existsSync(latestPath(fx))).toBe(false);
  });

  it('N17b: the same rejection settles the run even when the failure result cannot be built', async () => {
    const fx = makeFixture('n17b', 4);
    mkdirSync(backupRoot(fx), { recursive: true, mode: 0o700 });
    // N13's malformed latest.json: every read of the backup half throws, so
    // the first result builder throws and the last-resort builder formats the
    // same rejection value. Like N13, this test never calls inspect().
    writeFileSync(latestPath(fx), JSON.stringify({ backupPath: 42, treeHash: 'c8-not-a-tree-hash' }));
    const events: AuthBondCaptureEvent[] = [];
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: firstYieldRejects(NO_STRING_FORM),
    });

    const result = await settledWithin(guard.capture('connection-open'));
    const shutdown = await settledWithin(guard.shutdownCaptures());

    expect(result, 'the run never settled').not.toBe(PENDING);
    expect(shutdown, 'shutdownCaptures never resolved').not.toBe(PENDING);
    const settled = result as AuthBondCaptureResult;
    expect(settled).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(settled.error).toContain(`${NO_STRING_FORM_ERROR}; failure result unreadable: `);
    expect(settled.snapshot).toMatchObject({ status: 'unknown', issues: ['auth_bond_capture_result_unread'] });
    expect(finishedEvents(events).map((event) => [event.run, event.outcome])).toEqual([[1, 'failed']]);
  });
});

/** N13's malformed latest.json: a truthy non-string backupPath, so every read of the backup half throws. */
const MALFORMED_LATEST = JSON.stringify({ backupPath: 42, treeHash: 'c8-not-a-tree-hash' });
/** Every field of a refused result but its snapshot. */
const REFUSED = {
  ok: false,
  captured: false,
  deferred: false,
  aborted: true,
  path: null,
  error: 'auth bond capture refused: shutting down',
};
/** Every field of a run aborted by shutdown but its snapshot. */
const SHUTDOWN_ABORTED = {
  ok: false,
  captured: false,
  deferred: false,
  aborted: true,
  path: null,
  error: 'auth bond capture aborted: shutting down',
};

type Outcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }
  | { readonly status: 'pending' };

/**
 * settledWithin, with a rejection recorded instead of left unhandled, so a
 * promise that should resolve and rejects shows its reason in the failure.
 */
async function outcomeWithin<T>(promise: Promise<T>, turns = 200): Promise<Outcome<T>> {
  const box: { outcome: Outcome<T> } = { outcome: { status: 'pending' } };
  void promise.then(
    (value) => { box.outcome = { status: 'fulfilled', value }; },
    (reason: unknown) => { box.outcome = { status: 'rejected', reason }; },
  );
  for (let turn = 0; turn < turns && box.outcome.status === 'pending'; turn += 1) await macrotask();
  return box.outcome;
}

/** The value of an outcome that an earlier assertion required to be fulfilled. */
function fulfilledValue<T>(outcome: Outcome<T>): T {
  return (outcome as Extract<Outcome<T>, { status: 'fulfilled' }>).value;
}

/**
 * A captureYield that parks the next yield after `gate.park` is set, forever:
 * that run stops before its next live snapshot, and only an abort, through the
 * run's wake promise, ends it. Every other yield is a macrotask.
 */
function parkingYield(gate: { park: boolean; parked: number }): () => Promise<void> {
  return async () => {
    if (gate.park) {
      gate.park = false;
      gate.parked += 1;
      await new Promise<void>(() => undefined);
    }
    await macrotask();
  };
}

function writeMalformedLatest(fx: Fixture): void {
  mkdirSync(backupRoot(fx), { recursive: true, mode: 0o700 });
  writeFileSync(latestPath(fx), MALFORMED_LATEST);
}

describe('C8 FIX 4: refused and aborted results are built without reading the disk', () => {
  it('N18a: shutdown during a parked run settles the folded request refused and aborts the run, on a malformed latest.json', async () => {
    const fx = makeFixture('n18a', 4);
    writeMalformedLatest(fx);
    const events: AuthBondCaptureEvent[] = [];
    const gate = { park: true, parked: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: parkingYield(gate),
    });

    const first = guard.capture('connection-open');
    // Made while run 1 is active, so it folds into the trailing run.
    const folded = guard.capture('creds-update-settled');
    // Coverage: run 1 is parked at its first yield, before its first live
    // snapshot, and no run has settled, so no snapshot is held for a refusal.
    expect(gate.parked).toBe(1);
    expect(finishedEvents(events)).toEqual([]);

    const shutdown = await outcomeWithin(guard.shutdownCaptures());
    const foldedOutcome = await outcomeWithin(folded);
    const firstOutcome = await outcomeWithin(first);

    expect(shutdown).toEqual({ status: 'fulfilled', value: undefined });
    expect(foldedOutcome).toMatchObject({ status: 'fulfilled', value: REFUSED });
    expect(fulfilledValue(foldedOutcome).blocked).toBeUndefined();
    expect(firstOutcome).toMatchObject({ status: 'fulfilled', value: SHUTDOWN_ABORTED });
    expect(startedEvents(events).map((event) => event.run)).toEqual([1]);
    expect(finishedEvents(events).map((event) => [event.run, event.outcome])).toEqual([[1, 'aborted']]);
    expect(historyEntries(fx)).toEqual([]);
    expect(readFileSync(latestPath(fx), 'utf8')).toBe(MALFORMED_LATEST);

    // A later request resolves a refusal, and the call itself does not throw.
    const later: { promise: Promise<AuthBondCaptureResult> | null } = { promise: null };
    expect(() => { later.promise = guard.capture('after-shutdown'); }).not.toThrow();
    expect(await outcomeWithin(later.promise!)).toMatchObject({ status: 'fulfilled', value: REFUSED });
  });

  it('N18b: capture() after shutdown, before any run has settled, resolves a refusal on a malformed latest.json', async () => {
    const fx = makeFixture('n18b', 4);
    writeMalformedLatest(fx);
    const events: AuthBondCaptureEvent[] = [];
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
    });
    // Coverage: no run is active or folded, so shutdown builds no result.
    expect(await outcomeWithin(guard.shutdownCaptures())).toEqual({ status: 'fulfilled', value: undefined });

    const later: { promise: Promise<AuthBondCaptureResult> | null } = { promise: null };
    expect(() => { later.promise = guard.capture('after-shutdown'); }).not.toThrow();
    const outcome = await outcomeWithin(later.promise!);

    expect(outcome).toMatchObject({ status: 'fulfilled', value: REFUSED });
    const refused = fulfilledValue(outcome);
    expect(refused.blocked).toBeUndefined();
    // Read from nothing: no tree evidence, and the guard's health fields untouched.
    expect(refused.snapshot).toMatchObject({ status: 'unknown', treeHash: null });
    expect(refused.snapshot.backup.lastCaptureError).toBeNull();
    expect(startedEvents(events)).toEqual([]);
    expect(readFileSync(latestPath(fx), 'utf8')).toBe(MALFORMED_LATEST);
  });

  it('N18c: a run aborted before any run has settled settles aborted on a malformed latest.json', async () => {
    const fx = makeFixture('n18c', 4);
    writeMalformedLatest(fx);
    const events: AuthBondCaptureEvent[] = [];
    const gate = { park: true, parked: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      onCaptureEvent: (event) => { events.push(event); },
      captureYield: parkingYield(gate),
    });

    const run = guard.capture('connection-open');
    // Coverage: parked before its first live snapshot, with no run settled and
    // no request folded, so shutdown builds only the aborted result.
    expect(gate.parked).toBe(1);
    const shutdown = await outcomeWithin(guard.shutdownCaptures());
    const outcome = await outcomeWithin(run);

    expect(shutdown).toEqual({ status: 'fulfilled', value: undefined });
    expect(outcome).toMatchObject({ status: 'fulfilled', value: SHUTDOWN_ABORTED });
    const aborted = fulfilledValue(outcome);
    expect(aborted.blocked).toBeUndefined();
    // An abort is not a failure: no tree evidence, and the health fields untouched.
    expect(aborted.snapshot).toMatchObject({ status: 'unknown', treeHash: null });
    expect(aborted.snapshot.backup.lastCaptureError).toBeNull();
    expect(finishedEvents(events).map((event) => [event.run, event.outcome])).toEqual([[1, 'aborted']]);
    expect(historyEntries(fx)).toEqual([]);
    expect(readFileSync(latestPath(fx), 'utf8')).toBe(MALFORMED_LATEST);
  });

  it('N18d: a refusal and an abort before any run has settled make no synchronous fs call', async () => {
    const counter = { ops: 0 };
    const { AuthBondGuard: CountingGuard } = await importGuardCountingFs(counter);

    // The abort: run 1 parks at its first yield, and shutdown aborts it.
    const abortFx = makeFixture('n18d-abort', 4);
    const gate = { park: true, parked: 0 };
    const aborting = new CountingGuard({
      authDir: abortFx.authDir,
      stateRoot: abortFx.stateRoot,
      instanceName: abortFx.name,
      captureYield: parkingYield(gate),
    });
    const run = aborting.capture('connection-open');
    // Coverage: parked before its first live snapshot, with no run settled.
    expect(gate.parked).toBe(1);
    const opsBeforeAbort = counter.ops;
    const shutdown = await outcomeWithin(aborting.shutdownCaptures());
    const aborted = await outcomeWithin(run);
    const abortOps = counter.ops - opsBeforeAbort;

    // The refusal: after shutdown, on a guard that never ran a capture.
    const refuseFx = makeFixture('n18d-refuse', 4);
    const refusing = new CountingGuard({
      authDir: refuseFx.authDir,
      stateRoot: refuseFx.stateRoot,
      instanceName: refuseFx.name,
    });
    await outcomeWithin(refusing.shutdownCaptures());
    const opsBeforeRefusal = counter.ops;
    const refusal = refusing.capture('after-shutdown');
    const refusalOps = counter.ops - opsBeforeRefusal;

    // Coverage: both results were built, with the flags the other tests pin.
    expect(shutdown).toEqual({ status: 'fulfilled', value: undefined });
    expect(aborted).toMatchObject({ status: 'fulfilled', value: SHUTDOWN_ABORTED });
    expect(await outcomeWithin(refusal)).toMatchObject({ status: 'fulfilled', value: REFUSED });
    // Coverage: the counting import counts this guard's reads, so a zero below means none.
    const opsBeforeInspect = counter.ops;
    refusing.inspect();
    expect(counter.ops - opsBeforeInspect, 'the counting import counted nothing').toBeGreaterThan(0);
    expect({ abortOps, refusalOps }).toEqual({ abortOps: 0, refusalOps: 0 });
  });

  it('N18e: control: after a run has settled, refusals and an abort carry that run\'s snapshot unchanged', async () => {
    const fx = makeFixture('n18e', 4);
    const gate = { park: false, parked: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: parkingYield(gate),
    });
    const settled = await guard.capture('connection-open');
    expect(settled).toMatchObject({ ok: true, captured: true });
    // Coverage: latest.json is valid and names run 1's backup, and run 1's
    // snapshot is tree evidence, not an unread one.
    expect(JSON.parse(readFileSync(latestPath(fx), 'utf8'))).toMatchObject({ backupPath: settled.path });
    expect(settled.snapshot).toMatchObject({
      status: 'present',
      treeHash: expect.any(String),
      backup: { latest: settled.path },
    });

    // Run 2 parks at its first yield, so its aborted result has no snapshot of its own.
    gate.park = true;
    const second = guard.capture('creds-update-settled');
    const folded = guard.capture('auth-bond-capture-deferred');
    expect(gate.parked).toBe(1);
    const shutdown = await outcomeWithin(guard.shutdownCaptures());
    const foldedOutcome = await outcomeWithin(folded);
    const secondOutcome = await outcomeWithin(second);
    const laterOutcome = await outcomeWithin(guard.capture('after-shutdown'));

    expect(shutdown).toEqual({ status: 'fulfilled', value: undefined });
    expect(foldedOutcome).toMatchObject({ status: 'fulfilled', value: REFUSED });
    expect(secondOutcome).toMatchObject({ status: 'fulfilled', value: SHUTDOWN_ABORTED });
    expect(laterOutcome).toMatchObject({ status: 'fulfilled', value: REFUSED });
    expect(fulfilledValue(foldedOutcome).snapshot).toEqual(settled.snapshot);
    expect(fulfilledValue(secondOutcome).snapshot).toEqual(settled.snapshot);
    expect(fulfilledValue(laterOutcome).snapshot).toEqual(settled.snapshot);
  });

  it('N18f: control: a run that fails before any run has settled still reads creds.json live', async () => {
    const fx = makeFixture('n18f', 4);
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      // As in N17a: the first yield's rejection reaches the failure result builder.
      captureYield: firstYieldRejects(new Error('c8-fix4-control-hook-fault')),
    });

    const outcome = await outcomeWithin(guard.capture('connection-open'));

    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: { ok: false, captured: false, deferred: false, path: null },
    });
    const failed = fulfilledValue(outcome);
    expect(failed.error).toContain('c8-fix4-control-hook-fault');
    expect(failed.aborted).toBeUndefined();
    // The failure builder is outside this fix: its snapshot still has a live creds.json read.
    expect(failed.snapshot.creds.exists).toBe(true);
    expect(typeof failed.snapshot.creds.sha256).toBe('string');
    expect(failed.snapshot.issues).not.toContain('auth_bond_capture_result_unread');
    expect(await outcomeWithin(guard.shutdownCaptures())).toEqual({ status: 'fulfilled', value: undefined });
  });

  it('N18g: shutdown still aborts the run and settles the folded request when building the refusal throws', async () => {
    const fx = makeFixture('n18g', 4);
    const gate = { park: true, parked: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: parkingYield(gate),
    });
    // Stands in for a later builder change that reads the disk again and throws.
    const builders = guard as unknown as { refusedCaptureResult: () => AuthBondCaptureResult };
    const builder = vi.spyOn(builders, 'refusedCaptureResult').mockImplementationOnce(() => {
      throw new Error('c8-fix4-refusal-builder-fault');
    });

    const first = guard.capture('connection-open');
    const folded = guard.capture('creds-update-settled');
    // Coverage: run 1 is parked with a request folded behind it.
    expect(gate.parked).toBe(1);
    const shutdown = await outcomeWithin(guard.shutdownCaptures());
    const foldedOutcome = await outcomeWithin(folded);
    const firstOutcome = await outcomeWithin(first);

    // Coverage: shutdown built the folded result through the stubbed builder, and it threw.
    expect(builder.mock.results[0]?.type, 'the stubbed builder never threw').toBe('throw');
    expect(firstOutcome).toMatchObject({ status: 'fulfilled', value: SHUTDOWN_ABORTED });
    expect(foldedOutcome.status, 'the folded request never settled').not.toBe('pending');
    expect(shutdown.status, 'shutdownCaptures never settled').not.toBe('pending');
  });

  it('N18h: control: an abort before any run has settled leaves no unread snapshot for a later failure', async () => {
    const fx = makeFixture('n18h', 4);
    // The backup comes from another guard, so this guard restores with no run of its own settled.
    const seeder = new AuthBondGuard({ authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: fx.name });
    expect(await seeder.capture('connection-open')).toMatchObject({ ok: true, captured: true });
    expect(await outcomeWithin(seeder.shutdownCaptures())).toEqual({ status: 'fulfilled', value: undefined });
    // Run 1's first yield parks, and run 2's first yield rejects.
    const hook: { next: 'park' | 'reject' | null; parked: number } = { next: 'park', parked: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: fx.name,
      captureYield: async () => {
        const next = hook.next;
        hook.next = null;
        if (next === 'park') {
          hook.parked += 1;
          await new Promise<void>(() => undefined);
        }
        if (next === 'reject') throw new Error('c8-fix4-control-hook-fault');
        await macrotask();
      },
    });

    const first = guard.capture('connection-open');
    expect(hook.parked).toBe(1);
    // A definite, non-transient fault, as in N6, so the restore runs and aborts run 1.
    writeFileSync(join(fx.authDir, 'creds.json'), JSON.stringify({ registrationId: 9 }));
    const restored = guard.restoreLatestIfNeeded();
    const aborted = await outcomeWithin(first);
    // Coverage: a restore aborted run 1 before its first live snapshot, with no
    // run settled, and the guard keeps running.
    expect(restored).toMatchObject({ attempted: true, restored: true });
    expect(aborted).toMatchObject({
      status: 'fulfilled',
      value: {
        ok: false,
        captured: false,
        aborted: true,
        path: null,
        error: 'auth bond capture aborted: auth restore in progress',
      },
    });

    hook.next = 'reject';
    const outcome = await outcomeWithin(guard.capture('creds-update-settled'));

    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: { ok: false, captured: false, deferred: false, path: null },
    });
    const failed = fulfilledValue(outcome);
    expect(failed.error).toContain('c8-fix4-control-hook-fault');
    // As in N18f: run 2 failed before its own first snapshot, and its result
    // still carries a live creds.json read, not run 1's unread snapshot.
    expect(failed.snapshot.creds.exists).toBe(true);
    expect(typeof failed.snapshot.creds.sha256).toBe('string');
    expect(failed.snapshot.issues).not.toContain('auth_bond_capture_result_unread');
    expect(await outcomeWithin(guard.shutdownCaptures())).toEqual({ status: 'fulfilled', value: undefined });
  });
});
