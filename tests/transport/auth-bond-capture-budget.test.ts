// C8 FIX 2 (F2-1): one slice budget per capture run.
//
// A capture run shares one budget across every tree step it drives. A walk
// entry costs 1 unit, a copy or delete entry costs 4, and a slice holds at most
// 64 units, across phase boundaries and across the entries of a sweep or a
// prune. These tests record the guard's synchronous fs calls through a module
// mock, close a slice at every injected yield, and price each slice from the
// calls it holds. Test ids (B1-B4) match the F2-1 test list in the "FIX 2"
// section of the C8 design note.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

type FsModule = typeof import('node:fs');
type GuardModule = typeof import('../../src/transport/auth-bond.ts');

const tmp = trackTmpDirs('');

/** Neutral placeholder identity; the guard only hashes it. */
const IDENTITY = 'user-a:1@example.invalid';
const SLICE_UNITS = 64;
const WALK_ENTRY_UNITS = 1;
const WRITE_ENTRY_UNITS = 4;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:fs');
  vi.resetModules();
});

interface Fixture {
  readonly authDir: string;
  readonly stateRoot: string;
  readonly name: string;
}

function makeFixture(label: string, keyFiles: number): Fixture {
  const root = tmp.make(`whatsoup-auth-bond-budget-${label}`);
  const authDir = join(root, 'auth');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id: IDENTITY, lid: 'user-a-lid:1@example.invalid' },
    registrationId: 1,
  }));
  for (let index = 0; index < keyFiles; index += 1) {
    writeFileSync(
      join(authDir, `pre-key-${String(index).padStart(4, '0')}.json`),
      JSON.stringify({ keyData: `c8-budget-key-${index}` }),
    );
  }
  return { authDir, stateRoot: join(root, 'state'), name: `budget-${label}-bot` };
}

function backupRoot(fx: Fixture): string {
  return join(fx.stateRoot, 'auth-bond-backups', fx.name);
}

function historyRoot(fx: Fixture): string {
  return join(backupRoot(fx), 'history');
}

function stagingRoot(fx: Fixture): string {
  return join(backupRoot(fx), 'staging');
}

function listOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

interface FsCall {
  readonly fn: string;
  readonly path: string;
  /** rmSync only: the path was a directory that still held entries when removed. */
  readonly populatedDir: boolean;
}

/**
 * Import the guard with every synchronous fs call recorded, in order. Only
 * `*Sync` functions are wrapped, because the capture path uses no other kind.
 */
async function importGuardRecordingFs(calls: FsCall[]): Promise<GuardModule> {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<FsModule>();
    const isPopulatedDir = (path: unknown): boolean => {
      try {
        return actual.lstatSync(String(path)).isDirectory() && actual.readdirSync(String(path)).length > 0;
      } catch {
        return false;
      }
    };
    const recorded: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(actual)) {
      if (typeof value !== 'function' || !name.endsWith('Sync')) continue;
      const original = value as (...args: unknown[]) => unknown;
      recorded[name] = (...args: unknown[]) => {
        calls.push({
          fn: name,
          path: String(args[0]),
          populatedDir: name === 'rmSync' && isPopulatedDir(args[0]),
        });
        return original(...args);
      };
    }
    return { ...actual, ...recorded };
  });
  return import('../../src/transport/auth-bond.ts');
}

/** Fixture files whose lstat is one walk entry. */
const PRICED_FILE = /^(pre-key|orphan)-\d+\.json$/;

/**
 * Price one slice from the calls it holds. The price is a lower bound of the
 * design's units, so a run that keeps every slice within 64 units also keeps
 * this price within 64:
 * - an lstat of a fixture file (pre-key-*, orphan-*) is one walk entry: 1;
 * - a copyFileSync is one copy entry: 4, priced on its source path;
 * - an rmSync or unlinkSync of a .json file is one delete entry: 4;
 * - an lstat of a history entry inside the prune's listing (the previous call
 *   listed history/ or lstat'd another history entry, and the next call does
 *   not list the entry itself) is one walk entry: 1.
 * Each path is priced once per slice, at its highest price, so the lstat that
 * precedes a copy or a delete of the same file is not priced again.
 *
 * Not priced: the auth, staging and history roots; creds.json and
 * manifest.json reads; the snapshot's cheap half (its lstats of the auth root
 * and its creds.json read); the lstat that backupPathProblem takes of the entry
 * latest.json names (its previous call reads latest.json); directory entries;
 * and every whole-directory read (readdirSync plus sort), which the design
 * names as an unsliced chunk and which counts as zero units here.
 */
function sliceUnits(calls: readonly FsCall[], start: number, end: number, history: string): number {
  const priced = new Map<string, number>();
  const price = (path: string, units: number): void => {
    priced.set(path, Math.max(priced.get(path) ?? 0, units));
  };
  for (let index = start; index < end; index += 1) {
    const call = calls[index]!;
    if (call.fn === 'copyFileSync') {
      price(call.path, WRITE_ENTRY_UNITS);
      continue;
    }
    if ((call.fn === 'rmSync' || call.fn === 'unlinkSync') && call.path.endsWith('.json')) {
      price(call.path, WRITE_ENTRY_UNITS);
      continue;
    }
    if (call.fn !== 'lstatSync') continue;
    if (PRICED_FILE.test(basename(call.path))) {
      price(call.path, WALK_ENTRY_UNITS);
      continue;
    }
    if (dirname(call.path) !== history) continue;
    const previous = index > 0 ? calls[index - 1] : undefined;
    const next = calls[index + 1];
    const inListing = previous !== undefined && (
      (previous.fn === 'readdirSync' && previous.path === history)
      || (previous.fn === 'lstatSync' && dirname(previous.path) === history)
    );
    const expands = next !== undefined && next.fn === 'readdirSync' && next.path === call.path;
    if (inListing && !expands) price(call.path, WALK_ENTRY_UNITS);
  }
  let units = 0;
  for (const value of priced.values()) units += value;
  return units;
}

/** Records the fs calls of one capture run and the price of each of its slices. */
class SliceRecorder {
  readonly calls: FsCall[] = [];
  readonly slices: number[] = [];
  private readonly history: string;
  private start = 0;

  constructor(history: string) {
    this.history = history;
  }

  /** Ignore every call made before the measured run. */
  begin(): void {
    this.start = this.calls.length;
    this.slices.length = 0;
  }

  /** Close the current slice: called at each yield, and once after the run. */
  close(): void {
    this.slices.push(sliceUnits(this.calls, this.start, this.calls.length, this.history));
    this.start = this.calls.length;
  }

  get maxUnits(): number {
    return Math.max(0, ...this.slices);
  }

  get totalUnits(): number {
    return this.slices.reduce((sum, units) => sum + units, 0);
  }
}

async function recordedGuard(fx: Fixture, options: { keepBackups?: number } = {}) {
  const recorder = new SliceRecorder(historyRoot(fx));
  const mod = await importGuardRecordingFs(recorder.calls);
  const guard = new mod.AuthBondGuard({
    authDir: fx.authDir,
    stateRoot: fx.stateRoot,
    instanceName: fx.name,
    ...options,
    captureYield: async () => {
      recorder.close();
      await macrotask();
    },
  });
  return { guard, recorder };
}

describe('C8 FIX 2: one slice budget per capture run', () => {
  it('B1: a slice never holds more than 64 units across the hardening-to-enumeration boundary', async () => {
    // 124 key files, creds.json and the root are 126 walk entries. With a
    // counter per generator, the harden walk's last slice holds 63 of them and
    // runs straight into the enumeration's first 63.
    const fx = makeFixture('b1', 124);
    const { guard, recorder } = await recordedGuard(fx);

    recorder.begin();
    const result = await guard.capture('connection-open');
    recorder.close();

    expect(result).toMatchObject({ ok: true, captured: true });
    // Coverage: the pricing saw at least the three walks of the pre-copy
    // snapshot, and the run crossed many slice boundaries.
    expect(recorder.totalUnits).toBeGreaterThanOrEqual(3 * 124);
    expect(recorder.slices.length).toBeGreaterThanOrEqual(10);
    expect(recorder.maxUnits).toBeLessThanOrEqual(SLICE_UNITS);
  });

  it('B2: a sweep of many small orphans stays within the slice budget', async () => {
    const fx = makeFixture('b2', 4);
    const otherPid = process.pid + 1;
    const orphans = 100;
    for (let index = 0; index < orphans; index += 1) {
      const id = String(index).padStart(4, '0');
      const orphan = join(stagingRoot(fx), `20200101T000000Z.orphan-${id}.0000000000000000.tmp-${otherPid}`);
      mkdirSync(orphan, { recursive: true, mode: 0o700 });
      writeFileSync(join(orphan, `orphan-${id}.json`), '{}');
    }
    const { guard, recorder } = await recordedGuard(fx);

    recorder.begin();
    const result = await guard.capture('connection-open');
    recorder.close();

    expect(result).toMatchObject({ ok: true, captured: true });
    // Coverage: the sweep removed every orphan, and each removal was priced.
    expect(listOrEmpty(stagingRoot(fx))).toEqual([]);
    expect(recorder.totalUnits).toBeGreaterThanOrEqual(orphans * WRITE_ENTRY_UNITS);
    expect(recorder.maxUnits).toBeLessThanOrEqual(SLICE_UNITS);
  });

  it('B3: a prune over many history entries stays within the slice budget', async () => {
    const fx = makeFixture('b3', 4);
    const stale = 150;
    for (let index = 0; index < stale; index += 1) {
      const entry = join(historyRoot(fx), `20200101T000000Z.seed-${String(index).padStart(4, '0')}.0000000000000000`);
      mkdirSync(entry, { recursive: true, mode: 0o700 });
      writeFileSync(join(entry, 'manifest.json'), '{}');
    }
    const { guard, recorder } = await recordedGuard(fx, { keepBackups: 2 });

    recorder.begin();
    const result = await guard.capture('connection-open');
    recorder.close();

    expect(result).toMatchObject({ ok: true, captured: true });
    // Coverage: the prune kept the new backup and the newest stale entry, and
    // every removal was priced.
    expect(listOrEmpty(historyRoot(fx))).toHaveLength(2);
    expect(listOrEmpty(historyRoot(fx))).toContain(basename(result.path!));
    expect(recorder.totalUnits).toBeGreaterThanOrEqual((stale - 1) * WRITE_ENTRY_UNITS);
    expect(recorder.maxUnits).toBeLessThanOrEqual(SLICE_UNITS);
  });

  it('B4: a failed latest.json write removes the renamed entry in slices, never as one tree', async () => {
    const keyFiles = 40;
    const fx = makeFixture('b4', keyFiles);
    // latest.json is a folder, so the pointer write fails after the rename into history/.
    mkdirSync(join(backupRoot(fx), 'latest.json'), { recursive: true, mode: 0o700 });
    const { guard, recorder } = await recordedGuard(fx);

    recorder.begin();
    const result = await guard.capture('connection-open');
    recorder.close();

    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('refusing to write auth-bond json');
    // Coverage: the run reached the publish turn and renamed its copy into history/.
    expect(recorder.calls.some((call) => call.fn === 'renameSync' && dirname(call.path) === stagingRoot(fx)))
      .toBe(true);
    // No removal took a folder that still held entries, so no recursive rmSync
    // removed the renamed tree in one turn, and nothing was removed inside history/.
    expect(recorder.calls.filter((call) => call.populatedDir).map((call) => call.path)).toEqual([]);
    expect(recorder.calls.filter((call) => (call.fn === 'rmSync' || call.fn === 'unlinkSync')
      && call.path.startsWith(`${historyRoot(fx)}${sep}`))).toEqual([]);
    // The tree went back into staging and was removed there, file by file:
    // every key file, creds.json and manifest.json.
    const stagedRemovals = recorder.calls.filter((call) => (call.fn === 'rmSync' || call.fn === 'unlinkSync')
      && call.path.startsWith(`${stagingRoot(fx)}${sep}`) && call.path.endsWith('.json'));
    expect(stagedRemovals).toHaveLength(keyFiles + 2);
    expect(listOrEmpty(historyRoot(fx))).toEqual([]);
    expect(listOrEmpty(stagingRoot(fx))).toEqual([]);
    expect(recorder.maxUnits).toBeLessThanOrEqual(SLICE_UNITS);
  });
});
