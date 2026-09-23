import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertIsolatedStaticArgv,
  mockIsolatedChildWithHook,
  writeIsolatedChildHook,
} from '../helpers/isolated-child-hook.ts';
import {
  createPrivateFileIsolatedSync,
  privatePublicationStateOf,
  writeAtomicPrivateFileIsolatedSync,
} from '../../src/lib/private-fs-isolated.ts';

let tmpRoot = '';

afterEach(() => {
  vi.doUnmock('node:crypto');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  vi.resetModules();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'private-fs-isolated-test-'));
  return tmpRoot;
}

type IsolatedModule = typeof import('../../src/lib/private-fs-isolated.ts');

async function importIsolated(): Promise<IsolatedModule> {
  return import('../../src/lib/private-fs-isolated.ts');
}

function catchError(fn: () => void): NodeJS.ErrnoException | undefined {
  try {
    fn();
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  return undefined;
}

const assertStaticArgv = assertIsolatedStaticArgv;
const mockChildWithHook = mockIsolatedChildWithHook;
const writeHook = writeIsolatedChildHook;

const tempFiles = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

describe('default writers stay in-process', () => {
  it('does not spawn a child for writeAtomicPrivateFileSync or writePrivateJsonMarkerSync', async () => {
    const root = makeTmp();
    const target = join(root, 'priv', 'state.json');
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const spawnSyncSpy = vi.fn(actualChildProcess.spawnSync);

    vi.resetModules();
    vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawnSync: spawnSyncSpy }));
    const privateFs = await import('../../src/lib/private-fs.ts');
    const isolated = await importIsolated();

    privateFs.writeAtomicPrivateFileSync(target, 'payload', 'state');
    privateFs.writePrivateJsonMarkerSync(join(root, 'priv', 'marker.json'), { ok: true });

    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe('payload');
    // Control: the opt-in writer does spawn through the same spy.
    isolated.writeAtomicPrivateFileIsolatedSync(join(root, 'priv', 'isolated.json'), 'payload', 'state');
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe('writeAtomicPrivateFileIsolatedSync', () => {
  it('replaces a file at mode 0600 and leaves no temp behind', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, 'credential.key');
    writeFileSync(target, 'old', { mode: 0o644 });

    writeAtomicPrivateFileIsolatedSync(target, 'new', 'credential');

    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(tempFiles(dir)).toEqual([]);
  }, 10_000);

  it('fsyncs the file before rename and the parent directory after rename', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const eventLog = join(root, 'atomic-order.events');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hookPath = writeHook(root, 'atomic-order-hook.mjs', String.raw`
import fs from 'node:fs';
const originalFstat = fs.fstatSync.bind(fs);
const originalFsync = fs.fsyncSync.bind(fs);
const originalRename = fs.renameSync.bind(fs);
const log = (event) => fs.appendFileSync(process.env.WHATSOUP_TEST_EVENT_LOG, event + '\n');
fs.fsyncSync = function (descriptor) {
  log(originalFstat(descriptor).isDirectory() ? 'parent-fsync' : 'file-fsync');
  return originalFsync(descriptor);
};
fs.renameSync = function (from, to) {
  log('rename');
  return originalRename(from, to);
};
`);

    vi.resetModules();
    await mockChildWithHook(hookPath, { WHATSOUP_TEST_EVENT_LOG: eventLog });
    const isolated = await importIsolated();

    isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential');

    const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    expect(events).toEqual(['file-fsync', 'rename', 'parent-fsync']);
    expect(readFileSync(target, 'utf8')).toBe('credential');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  }, 10_000);

  it('removes its temp and reports not-published when rename fails', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hookPath = writeHook(root, 'rename-fault-hook.mjs', String.raw`
import fs from 'node:fs';
fs.renameSync = function () {
  throw new Error('simulated rename failure');
};
`);

    vi.resetModules();
    await mockChildWithHook(hookPath);
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'));

    expect(caught?.code).toBe('EIO');
    expect(caught?.message).not.toMatch(/simulated rename failure/);
    expect(isolated.privatePublicationStateOf(caught)).toBe('not-published');
    expect(existsSync(target)).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
  }, 10_000);

  it('does not publish and removes its temp when file fsync fails', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hookPath = writeHook(root, 'fsync-fault-hook.mjs', String.raw`
import fs from 'node:fs';
const originalFstat = fs.fstatSync.bind(fs);
const originalFsync = fs.fsyncSync.bind(fs);
let faulted = false;
fs.fsyncSync = function (descriptor) {
  if (!faulted && !originalFstat(descriptor).isDirectory()) {
    faulted = true;
    throw new Error('simulated file fsync failure');
  }
  return originalFsync(descriptor);
};
`);

    vi.resetModules();
    await mockChildWithHook(hookPath);
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'));

    expect(caught?.code).toBe('EIO');
    expect(isolated.privatePublicationStateOf(caught)).toBe('not-published');
    expect(existsSync(target)).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
  }, 10_000);

  it('reports a required directory fsync failure as published, not as a failed write', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'state.marker');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hookPath = writeHook(root, 'dir-fsync-fault-hook.mjs', String.raw`
import fs from 'node:fs';
const originalFstat = fs.fstatSync.bind(fs);
const originalFsync = fs.fsyncSync.bind(fs);
fs.fsyncSync = function (descriptor) {
  if (originalFstat(descriptor).isDirectory()) throw new Error('directory fsync unavailable');
  return originalFsync(descriptor);
};
`);

    vi.resetModules();
    await mockChildWithHook(hookPath);
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'generation-3', 'marker', 'required'));

    expect(caught?.code).toBe('EIO');
    expect(caught?.message).not.toMatch(/directory fsync unavailable/);
    expect(isolated.privatePublicationStateOf(caught)).toBe('published');
    expect(readFileSync(target, 'utf8')).toBe('generation-3');

    // Best-effort mode tolerates the same fault.
    isolated.writeAtomicPrivateFileIsolatedSync(target, 'generation-4', 'marker');
    expect(readFileSync(target, 'utf8')).toBe('generation-4');
  }, 10_000);

  it('reports a failed parent read-back after the child published as published', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, 'credential.key');
    const canonicalTarget = join(realpathSync(dir), 'credential.key');
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: vi.fn((...args: Parameters<typeof actualFs.openSync>) => {
        if (String(args[0]) === canonicalTarget) {
          throw Object.assign(new Error('simulated read-back failure'), { code: 'EIO' });
        }
        return actualFs.openSync(...args);
      }),
    }));
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'));

    expect(caught?.code).toBe('EIO');
    expect(isolated.privatePublicationStateOf(caught)).toBe('published');
    expect(readFileSync(target, 'utf8')).toBe('credential');
  }, 10_000);

  it('binds mutations to the opened directory across an ancestor exchange', async () => {
    // Exchange the target directory for a symlink to an outside directory at
    // the moment the temp file is opened. The seam fires on a parent-side
    // open too, so the exchange is exercised whichever process writes.
    const root = makeTmp();
    const dir = join(root, 'priv');
    const displaced = join(root, 'priv-displaced');
    const outside = join(root, 'outside');
    const target = join(dir, 'credential.key');
    const fixedId = 'atomic-ancestor-exchange';
    const tempName = `.credential.key.${process.pid}.${fixedId}.tmp`;
    const displacedTarget = join(displaced, 'credential.key');
    const outsideTarget = join(outside, 'credential.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(target, 'original-target', { mode: 0o600 });
    writeFileSync(outsideTarget, 'outside-target', { mode: 0o640 });
    const originalTargetBefore = statSync(target);
    const outsideTargetBefore = statSync(outsideTarget);
    const hookPath = writeHook(root, 'atomic-ancestor-exchange-hook.mjs', String.raw`
import fs from 'node:fs';
import path from 'node:path';
const originalOpen = fs.openSync.bind(fs);
let exchanged = false;
fs.openSync = function (candidate, ...args) {
  if (!exchanged && path.basename(String(candidate)) === process.env.WHATSOUP_ATOMIC_TEMP_NAME) {
    exchanged = true;
    fs.renameSync(process.env.WHATSOUP_ATOMIC_DIR, process.env.WHATSOUP_ATOMIC_DISPLACED);
    fs.symlinkSync(process.env.WHATSOUP_ATOMIC_OUTSIDE, process.env.WHATSOUP_ATOMIC_DIR);
  }
  return originalOpen(candidate, ...args);
};
`);
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    let parentExchanged = false;

    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomUUID: () => fixedId,
    }));
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: vi.fn((...args: Parameters<typeof actualFs.openSync>) => {
        if (!parentExchanged && String(args[0]).endsWith(`/${tempName}`)) {
          parentExchanged = true;
          actualFs.renameSync(dir, displaced);
          actualFs.symlinkSync(outside, dir);
        }
        return actualFs.openSync(...args);
      }),
    }));
    const child = await mockChildWithHook(hookPath, {
      WHATSOUP_ATOMIC_TEMP_NAME: tempName,
      WHATSOUP_ATOMIC_DIR: dir,
      WHATSOUP_ATOMIC_DISPLACED: displaced,
      WHATSOUP_ATOMIC_OUTSIDE: outside,
    });
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'replacement', 'credential'));

    // The exchange must have happened, in one process or the other.
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    // Nothing is written through the decoy.
    expect(readFileSync(outsideTarget, 'utf8')).toBe('outside-target');
    expect(statSync(outsideTarget).ino).toBe(outsideTargetBefore.ino);
    expect(statSync(outsideTarget).mode & 0o777).toBe(0o640);
    expect(tempFiles(outside)).toEqual([]);
    // The write fails closed, and the original target is untouched.
    expect(caught?.code).toBe('ESTALE');
    expect(isolated.privatePublicationStateOf(caught)).toBe('not-published');
    expect(child.spawned()).toBe(true);
    expect(parentExchanged).toBe(false);
    expect(readFileSync(displacedTarget, 'utf8')).toBe('original-target');
    expect(statSync(displacedTarget).ino).toBe(originalTargetBefore.ino);
    expect(tempFiles(displaced)).toEqual([]);
  }, 10_000);

  it('writes through a directory whose path crosses a pre-existing symlinked ancestor', () => {
    // Binding canonicalizes first, so a platform symlink already in the path
    // (for example /var -> /private/var on macOS) is not treated as an attack.
    const root = makeTmp();
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(join(real, 'priv'), { recursive: true, mode: 0o700 });
    symlinkSync(real, link);

    writeAtomicPrivateFileIsolatedSync(join(link, 'priv', 'credential.key'), 'credential', 'credential');

    expect(readFileSync(join(real, 'priv', 'credential.key'), 'utf8')).toBe('credential');
    expect(statSync(join(real, 'priv', 'credential.key')).mode & 0o777).toBe(0o600);
  }, 10_000);

  it('refuses a symlinked target directory without writing through it', () => {
    const root = makeTmp();
    const outside = join(root, 'outside');
    const link = join(root, 'priv');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, link);

    const caught = catchError(() => writeAtomicPrivateFileIsolatedSync(join(link, 'credential.key'), 'credential', 'credential'));

    expect(caught?.code).toBe('ELOOP');
    expect(privatePublicationStateOf(caught)).toBe('not-published');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('passes specific filesystem errors through instead of collapsing them to EIO', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const observed: string[] = [];
    for (const code of ['EROFS', 'EDQUOT', 'EPERM', 'ENAMETOOLONG']) {
      const hookPath = writeHook(root, `open-fault-${code}.mjs`, String.raw`
import fs from 'node:fs';
const originalOpen = fs.openSync.bind(fs);
fs.openSync = function (candidate, ...args) {
  if (String(candidate).endsWith('.tmp')) {
    const error = new Error('simulated'); error.code = ${JSON.stringify(code)}; throw error;
  }
  return originalOpen(candidate, ...args);
};
`);
      vi.resetModules();
      await mockChildWithHook(hookPath);
      const isolated = await importIsolated();
      const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'));
      observed.push(`${caught?.code}:${isolated.privatePublicationStateOf(caught)}`);
      vi.doUnmock('node:child_process');
    }

    expect(observed).toEqual([
      'EROFS:not-published',
      'EDQUOT:not-published',
      'EPERM:not-published',
      'ENAMETOOLONG:not-published',
    ]);
    expect(existsSync(target)).toBe(false);
  }, 20_000);

  it('reports a temp-name collision as a temp problem, not as an existing target', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const fixedId = 'fixed-temp-id';
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `.credential.key.${process.pid}.${fixedId}.tmp`), 'stranger', { mode: 0o600 });

    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomUUID: () => fixedId,
    }));
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'));

    expect(caught?.code).toBe('EEXIST');
    expect(caught?.message).toMatch(/temporary file already exists/);
    expect(caught?.message).not.toMatch(/refusing to create private file because it already exists/);
    expect(isolated.privatePublicationStateOf(caught)).toBe('not-published');
    expect(existsSync(target)).toBe(false);
  }, 10_000);

  it('classifies an invalid supervisor receipt as a sanitized failure with unknown publication', async () => {
    const root = makeTmp();
    const target = join(root, 'priv', 'credential.key');
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      ...actualChildProcess,
      spawnSync: vi.fn(() => ({
        pid: 1,
        output: [null, Buffer.from('synthetic-private-invalid-frame'), Buffer.alloc(0)],
        stdout: Buffer.from('synthetic-private-invalid-frame'),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
        error: undefined,
      })),
    }));
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'));

    expect(caught?.code).toBe('EIO');
    expect(String(caught?.message)).not.toContain('synthetic-private-invalid-frame');
    expect(isolated.privatePublicationStateOf(caught)).toBe('unknown');
    expect(existsSync(target)).toBe(false);
  });
});

describe('createPrivateFileIsolatedSync', () => {
  it('creates a new private file and refuses to replace an existing one', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'lease.json');

    createPrivateFileIsolatedSync(target, 'first', 'lease');
    const caught = catchError(() => createPrivateFileIsolatedSync(target, 'second', 'lease'));

    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(target).nlink).toBe(1);
    expect(caught?.code).toBe('EEXIST');
    expect(caught?.message).toMatch(/refusing to create private file because it already exists/);
    expect(privatePublicationStateOf(caught)).toBe('not-published');
    expect(tempFiles(dir)).toEqual([]);
  }, 10_000);

  it('loses an exclusive-create race atomically when the target appears after the pre-check', async () => {
    // The racer creates the target between the child's target check and its
    // link: link() must still fail EEXIST and the racer's bytes must survive.
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'lease.json');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hookPath = writeHook(root, 'link-race-hook.mjs', String.raw`
import fs from 'node:fs';
const originalLink = fs.linkSync.bind(fs);
fs.linkSync = function (from, to) {
  fs.writeFileSync(to, 'racer', { mode: 0o600, flag: 'wx' });
  return originalLink(from, to);
};
`);

    vi.resetModules();
    await mockChildWithHook(hookPath);
    const isolated = await importIsolated();

    const caught = catchError(() => isolated.createPrivateFileIsolatedSync(target, 'ours', 'lease'));

    expect(caught?.code).toBe('EEXIST');
    expect(isolated.privatePublicationStateOf(caught)).toBe('not-published');
    expect(readFileSync(target, 'utf8')).toBe('racer');
    expect(tempFiles(dir)).toEqual([]);
  }, 10_000);
});

describe('bounded supervision', () => {
  interface StallOptions {
    controlMode: 'valid' | 'corrupt';
    /** Child source that runs instead of the publishing child. */
    childSource: string;
  }

  async function mockStalledSupervisor(root: string, options: StallOptions): Promise<string> {
    const supervisorStatePath = join(root, 'supervisor.json');
    const readyPath = join(root, 'child-ready');
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.doMock('node:child_process', () => ({
      ...actualChildProcess,
      spawnSync: vi.fn((command: string, args: readonly string[], spawnOptions: SpawnSyncOptionsWithBufferEncoding) => {
        assertStaticArgv(args);
        if (!args[2].includes('child.stdin.end(frame);')) throw new Error('bounded supervisor source seam is unavailable');
        const stalledSource = args[2].replace('child.stdin.end(frame);', String.raw`
child.stdin.end(frame);
fs.writeFileSync(
  ${JSON.stringify(supervisorStatePath)},
  JSON.stringify({ supervisorPid: process.pid, childPid: child.pid }),
  { flag: 'wx', mode: 0o600 },
);
const testReadyDeadline = Date.now() + 1000;
const testReadyTimer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(readyPath)})) {
    clearInterval(testReadyTimer);
    for (;;) {}
  }
  if (Date.now() >= testReadyDeadline) process.exit(70);
}, 1);
`);
        const result = actualChildProcess.spawnSync(command, [
          args[0], args[1], stalledSource, options.childSource, args[4], args[5],
        ], { ...spawnOptions, timeout: 1_200, killSignal: 'SIGKILL' });
        const output = [...(result.output ?? [])];
        while (output.length < 4) output.push(null);
        if (options.controlMode === 'corrupt') {
          output[3] = Buffer.from('{"schemaVersion":1,"processGroupId":"private-invalid"}\n');
        }
        return { ...result, output };
      }),
    }));
    return supervisorStatePath;
  }

  function reapTestProcesses(pids: number[], groupId: number): boolean[] {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    const before = pids.map(alive);
    for (const pid of [-groupId, ...pids]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* intentional: test-owned cleanup, already gone */ }
    }
    return before;
  }

  it.each([
    ['valid', 'ETIMEDOUT', 'owned child exceeded its execution deadline'],
    ['corrupt', 'EOWNERDEAD', 'owned child process-group or temp cleanup is uncertain'],
  ] as const)(
    'reaps the child process group when the supervisor hits the outer deadline (%s control frame)',
    async (controlMode, expectedCode, expectedMessage) => {
      // A child that spawns a SIGTERM-ignoring descendant; the supervisor then
      // stalls and the outer spawnSync timeout kills it. The parent must reap
      // the detached group from the fd-3 control frame, or report cleanup as
      // uncertain.
      const root = makeTmp();
      const descendantPidPath = join(root, 'descendant.pid');
      const readyPath = join(root, 'child-ready');
      vi.resetModules();
      const statePath = await mockStalledSupervisor(root, {
        controlMode,
        childSource: String.raw`
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const descendant = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(${JSON.stringify(readyPath)}, '', { flag: 'wx', mode: 0o600 });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
      });
      const isolated = await importIsolated();
      const target = join(root, 'priv', 'credential.key');

      const failure = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(target, 'private-payload', 'credential'));

      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { supervisorPid: number; childPid: number };
      const aliveBeforeCleanup = reapTestProcesses(
        [state.supervisorPid, state.childPid, Number(readFileSync(descendantPidPath, 'utf8'))],
        state.childPid,
      );

      expect(failure).toMatchObject({ name: 'BoundedProcessError', code: expectedCode, message: expectedMessage });
      expect(String(failure?.message)).not.toMatch(/SIGKILL|processGroupId|[0-9]{3,}|private-fs-isolated-test/);
      expect(isolated.privatePublicationStateOf(failure)).toBe('unknown');
      if (controlMode === 'valid') expect(aliveBeforeCleanup).toEqual([false, false, false]);
      expect(existsSync(target)).toBe(false);
    },
    10_000,
  );

  it('removes the temp a killed child left behind, and reports uncertainty when it cannot', async () => {
    // The stand-in child creates the exact temp name (fixed UUID) and then
    // hangs, as a child blocked in a synchronous fsync would, so its own
    // SIGTERM cleanup never runs.
    const fixedId = 'orphan-temp-id';
    const results: Array<{ code: string | undefined; tempRemains: boolean }> = [];
    for (const shape of ['regular', 'symlink'] as const) {
      const root = makeTmp();
      const dir = join(root, 'priv');
      const readyPath = join(root, 'child-ready');
      const tempName = `.credential.key.${process.pid}.${fixedId}.tmp`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      vi.resetModules();
      vi.doMock('node:crypto', async (importOriginal) => ({
        ...(await importOriginal<typeof import('node:crypto')>()),
        randomUUID: () => fixedId,
      }));
      const createTemp = shape === 'regular'
        ? `fs.writeFileSync(${JSON.stringify(tempName)}, 'partial', { flag: 'wx', mode: 0o600 });`
        : `fs.symlinkSync(${JSON.stringify(join(root, 'elsewhere'))}, ${JSON.stringify(tempName)});`;
      const statePath = await mockStalledSupervisor(root, {
        controlMode: 'valid',
        childSource: String.raw`
import fs from 'node:fs';
${createTemp}
fs.writeFileSync(${JSON.stringify(readyPath)}, '', { flag: 'wx', mode: 0o600 });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
      });
      const isolated = await importIsolated();

      const failure = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(join(dir, 'credential.key'), 'payload', 'credential'));

      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { supervisorPid: number; childPid: number };
      reapTestProcesses([state.supervisorPid, state.childPid], state.childPid);
      let tempRemains = true;
      try { lstatSync(join(dir, tempName)); } catch { tempRemains = false; }
      results.push({ code: failure?.code, tempRemains });
      vi.doUnmock('node:crypto');
      vi.doUnmock('node:child_process');
      rmSync(root, { recursive: true, force: true });
      tmpRoot = '';
    }

    expect(results).toEqual([
      { code: 'ETIMEDOUT', tempRemains: false },
      { code: 'EOWNERDEAD', tempRemains: true },
    ]);
  }, 20_000);

  it('does not signal a process group that is already gone', async () => {
    const root = makeTmp();
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    // A real, already-exited process supplies a group id that no longer exists.
    const exited = actualChildProcess.spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const goneGroupId = exited.pid;
    const killSpy = vi.spyOn(process, 'kill');
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      ...actualChildProcess,
      spawnSync: vi.fn(() => ({
        pid: goneGroupId + 1,
        output: [null, Buffer.alloc(0), Buffer.alloc(0), Buffer.from(`${JSON.stringify({ schemaVersion: 1, processGroupId: goneGroupId })}\n`)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: 'SIGKILL',
        error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' }),
      })),
    }));
    const isolated = await importIsolated();

    const failure = catchError(() => isolated.writeAtomicPrivateFileIsolatedSync(join(root, 'priv', 'credential.key'), 'payload', 'credential'));

    expect(failure?.code).toBe('ETIMEDOUT');
    const groupSignals = killSpy.mock.calls.filter(([pid]) => pid === -goneGroupId).map(([, signal]) => signal);
    expect(groupSignals).toEqual([0]);
  }, 10_000);
});
