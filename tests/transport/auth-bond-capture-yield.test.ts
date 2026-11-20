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
import { basename, join } from 'node:path';
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
 * A yield hook that runs one pending mutation at the first yield after the
 * harden walk has repaired the sentinel's mode. The sentinel sorts after every
 * other entry, so the harden walk reaches it last; the next yield then falls
 * inside the tree walk, after the walk has listed the folder and before it has
 * read the files listed late.
 */
function midWalkYield(sentinel: string, state: { pending: (() => void) | null; fired: number }) {
  return async (): Promise<void> => {
    if (state.pending !== null && modeOf(sentinel) === 0o600) {
      const mutate = state.pending;
      state.pending = null;
      state.fired += 1;
      mutate();
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
