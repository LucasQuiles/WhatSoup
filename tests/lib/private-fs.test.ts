import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  appendPrivateJsonLineSync,
  assertPrivateDirectorySync,
  assertWritablePrivateFileSync,
  deletePrivateFileSync,
  ensurePrivateDirectorySync,
  forceEnsurePrivateDirectorySync,
  readPrivateFileSync,
  readFreshMarkerSync,
  writeAtomicPrivateFileIsolatedSync,
  writeAtomicPrivateFileSync,
  writePrivateFileSync,
  writePrivateJsonMarkerSync,
} from '../../src/lib/private-fs.ts';

let tmpRoot = '';
const originalGetuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');

afterEach(() => {
  if (originalGetuidDescriptor) {
    Object.defineProperty(process, 'getuid', originalGetuidDescriptor);
  } else {
    delete (process as NodeJS.Process & { getuid?: () => number }).getuid;
  }
  vi.doUnmock('node:crypto');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.resetModules();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'private-fs-test-'));
  return tmpRoot;
}

/**
 * writeAtomicPrivateFileIsolatedSync runs its temp write, fsync, and rename inside an
 * isolated child (spawned through a bounded supervisor). Tests observe or fault
 * those mutations by prepending a `require(hook)` to the child source and
 * letting the supervisor pass the test environment through to the child.
 */
function injectChildRequire(args: readonly string[], hookPath: string): string[] {
  if (
    args.length !== 6
    || args[0] !== '--input-type=commonjs'
    || args[1] !== '--eval'
    || typeof args[2] !== 'string'
    || typeof args[3] !== 'string'
  ) throw new Error('replacement supervisor argv is not the static contract');
  return [
    args[0],
    args[1],
    args[2].replace(
      "env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },",
      "env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },",
    ),
    `require(${JSON.stringify(hookPath)});\n${args[3]}`,
    args[4],
    args[5],
  ];
}

async function mockChildWithHook(hookPath: string, env: Record<string, string> = {}): Promise<{ spawned: () => boolean }> {
  const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  let spawned = false;
  vi.doMock('node:child_process', () => ({
    ...actualChildProcess,
    spawnSync: vi.fn((command: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding) => {
      spawned = true;
      return actualChildProcess.spawnSync(command, injectChildRequire(args, hookPath), {
        ...options,
        env: { ...options.env, ...env },
      });
    }),
  }));
  return { spawned: () => spawned };
}

function setTestUid(uid: number): void {
  Object.defineProperty(process, 'getuid', {
    configurable: true,
    value: () => uid,
  });
}

function mockedPrivateStat(
  type: 'directory' | 'file',
  uid: number,
): ReturnType<typeof lstatSync> {
  return {
    uid,
    mode: type === 'directory' ? 0o700 : 0o600,
    size: 0,
    isSymbolicLink: () => false,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
  } as ReturnType<typeof lstatSync>;
}

async function importWithMockedOwnership(
  dirPath: string,
  filePath: string,
  dirUid: number,
  fileUid: number,
): Promise<typeof import('../../src/lib/private-fs.ts')> {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.resetModules();
  vi.doMock('node:fs', () => ({
    ...actual,
    lstatSync: vi.fn((path: string) => {
      if (path === dirPath) return mockedPrivateStat('directory', dirUid);
      if (path === filePath) return mockedPrivateStat('file', fileUid);
      return actual.lstatSync(path);
    }),
  }));
  return import('../../src/lib/private-fs.ts');
}

describe('writePrivateFileSync', () => {
  it('refuses a pre-existing symlink at the file path (ELOOP) and writes mode 0600 for real files', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Symlink at target path — must refuse
    const target = join(dir, 'secret.json');
    const decoy = join(root, 'decoy.json');
    symlinkSync(decoy, target);

    let caughtErr: NodeJS.ErrnoException | undefined;
    try { writePrivateFileSync(target, '{"x":1}'); } catch (e) { caughtErr = e as NodeJS.ErrnoException; }
    expect(caughtErr).toBeDefined();
    expect(caughtErr?.code).toBe('ELOOP');

    // Write to a real file — confirm mode 0600
    const real = join(dir, 'real.json');
    writePrivateFileSync(real, '{"ok":true}');
    const st = statSync(real);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('refuses a target path that already exists as a directory', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'secret.json');
    mkdirSync(target, { recursive: true, mode: 0o700 });

    expect(() => writePrivateFileSync(target, '{"x":1}')).toThrow(/non-regular path/);
  });

  it('overwrites a pre-existing regular file and preserves mode 0600', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'secret.json');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(target, 'old', { mode: 0o644 });

    writePrivateFileSync(target, 'new');

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('closes the descriptor when a post-open fstat race finds a non-file', async () => {
    const closeSyncMock = vi.fn();
    const fd = 42;

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        lstatSync: vi.fn((path: string) => {
          if (path.endsWith('private-fixture')) {
            return {
              isSymbolicLink: () => false,
              isDirectory: () => true,
              isFile: () => false,
            };
          }
          const err = new Error('missing') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
        openSync: vi.fn(() => fd),
        fstatSync: vi.fn(() => ({ isFile: () => false })),
        closeSync: closeSyncMock,
      };
    });
    const { writePrivateFileSync: writeWithRacedFstat } = await import('../../src/lib/private-fs.ts');

    expect(() => writeWithRacedFstat('/tmp/private-fixture/secret.json', '{}')).toThrow(/non-regular path/);
    expect(closeSyncMock).toHaveBeenCalledWith(fd);
  });

  it('does not close an unopened descriptor when open fails', async () => {
    const closeSyncMock = vi.fn();

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        lstatSync: vi.fn((path: string) => {
          if (path.endsWith('priv')) {
            return {
              isSymbolicLink: () => false,
              isDirectory: () => true,
              isFile: () => false,
            };
          }
          const err = new Error('missing') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
        openSync: vi.fn(() => {
          throw new Error('open denied');
        }),
        closeSync: closeSyncMock,
      };
    });
    const { writePrivateFileSync: writeWithOpenFailure } = await import('../../src/lib/private-fs.ts');

    expect(() => writeWithOpenFailure('/tmp/private-fixture/priv/secret.json', '{}')).toThrow(/open denied/);
    expect(closeSyncMock).not.toHaveBeenCalled();
  });
});

describe('appendPrivateJsonLineSync', () => {
  it('appends newline-delimited JSON to a private 0600 file', () => {
    const root = makeTmp();
    const target = join(root, 'priv', 'events.ndjson');

    appendPrivateJsonLineSync(target, { event: 'one', count: 1 });
    appendPrivateJsonLineSync(target, { event: 'two', count: 2 });

    expect(statSync(target).mode & 0o777).toBe(0o600);
    const lines = readFileSync(target, 'utf-8').trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines).toEqual([
      { event: 'one', count: 1 },
      { event: 'two', count: 2 },
    ]);
  });

  it('refuses to append through a symlinked event file', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = join(root, 'outside.ndjson');
    const target = join(dir, 'events.ndjson');
    writeFileSync(outside, 'unchanged\n', { mode: 0o600 });
    symlinkSync(outside, target);

    expect(() => appendPrivateJsonLineSync(target, { event: 'blocked' })).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf-8')).toBe('unchanged\n');
  });

  it('fsyncs the parent directory on first creation but not on a later append', async () => {
    // Durability: on create, the file fsync flushes the data, but the directory
    // entry linking the filename to the inode is separate metadata — a crash
    // between the two can leave a named-but-unlinked inode and lose the whole
    // forensic file. fsyncDirectory opens the directory path and fsyncs its
    // descriptor. A plain append to an existing file does not touch the
    // directory entry, so that extra work must be skipped there. Falsifier:
    // deleting `if (willCreate) fsyncDirectory(dir)` makes the create assertion
    // fail (0 dir opens).
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'events.ndjson');

    const dirOpens: string[] = [];
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync: vi.fn((path: string, ...rest: unknown[]) => {
          if (path === dir) dirOpens.push(path);
          return (actual.openSync as (...a: unknown[]) => number)(path, ...rest);
        }),
      };
    });
    const { appendPrivateJsonLineSync: appendMocked } = await import('../../src/lib/private-fs.ts');

    appendMocked(target, { event: 'create', count: 1 });
    expect(dirOpens.length).toBeGreaterThanOrEqual(1); // parent dir fsynced on create

    dirOpens.length = 0;
    appendMocked(target, { event: 'extend', count: 2 });
    expect(dirOpens.length).toBe(0); // no dir fsync on a plain append

    // Regression: both lines present, file stays 0600.
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const lines = readFileSync(target, 'utf-8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { event: 'create', count: 1 },
      { event: 'extend', count: 2 },
    ]);
  });
});

describe('two-algorithm split: assert-first vs mkdir-then-force-chmod', () => {
  it('assertPrivateDirectorySync refuses symlinked and non-directory paths', () => {
    const root = makeTmp();
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    const filePath = join(root, 'not-dir');
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    symlinkSync(realDir, linkDir, 'dir');
    writeFileSync(filePath, 'not a directory');

    expect(() => assertPrivateDirectorySync(linkDir)).toThrow(/through symlink/);
    expect(() => assertPrivateDirectorySync(filePath)).toThrow(/non-directory path/);
  });

  it('ensurePrivateDirectorySync rethrows non-missing assertion failures', () => {
    const root = makeTmp();
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    symlinkSync(realDir, linkDir, 'dir');

    expect(() => ensurePrivateDirectorySync(linkDir)).toThrow(/through symlink/);
  });

  it('forceEnsurePrivateDirectorySync chmods a pre-existing 0755 dir to 0700', () => {
    const root = makeTmp();
    const dir = join(root, 'forcedir');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);

    // Verify starting mode
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    forceEnsurePrivateDirectorySync(dir, 'test-label');

    // Must have been chmoded to 0700
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('assertPrivateDirectorySync leaves a pre-existing 0755 dir untouched', () => {
    const root = makeTmp();
    const dir = join(root, 'assertdir');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);

    expect(statSync(dir).mode & 0o777).toBe(0o755);

    // assertPrivateDirectorySync does NOT chmod — it only asserts symlink/dir status
    assertPrivateDirectorySync(dir);

    // Mode must remain unchanged — the assert variant never touches it
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('ensurePrivateDirectorySync creates directory at mode 0700 but leaves existing untouched', () => {
    const root = makeTmp();
    const newDir = join(root, 'newdir');

    ensurePrivateDirectorySync(newDir);
    expect(statSync(newDir).mode & 0o777).toBe(0o700);
  });

  it('forceEnsurePrivateDirectorySync refuses a symlink after mkdir', () => {
    const root = makeTmp();
    const realDir = join(root, 'forced-real');
    const linkDir = join(root, 'forced-link');
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    symlinkSync(realDir, linkDir, 'dir');

    expect(() => forceEnsurePrivateDirectorySync(linkDir, 'test-label')).toThrow(/test-label through symlink/);
  });

  it('forceEnsurePrivateDirectorySync refuses a post-mkdir non-directory race', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        mkdirSync: vi.fn(),
        lstatSync: vi.fn(() => ({
          isSymbolicLink: () => false,
          isDirectory: () => false,
        })),
        chmodSync: vi.fn(),
      };
    });
    const { forceEnsurePrivateDirectorySync: forceEnsureWithRacedLstat } = await import('../../src/lib/private-fs.ts');

    expect(() => forceEnsureWithRacedLstat('/tmp/private-fixture/raced', 'raced label')).toThrow(
      /raced label over non-directory path/,
    );
  });

  it('ensurePrivateDirectorySync creates directory at mode 0700', () => {
    const root = makeTmp();
    const newDir = join(root, 'newdir');

    ensurePrivateDirectorySync(newDir);
    expect(statSync(newDir).mode & 0o777).toBe(0o700);
  });

  it('ensurePrivateDirectorySync chmods a pre-existing 0755 dir to 0700', () => {
    const root = makeTmp();
    const dir = join(root, 'ensuredir');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);

    expect(statSync(dir).mode & 0o777).toBe(0o755);

    ensurePrivateDirectorySync(dir);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('assertWritablePrivateFileSync', () => {
  it('returns ok (no throw) when the target does not exist (ENOENT)', () => {
    const root = makeTmp();
    const target = join(root, 'priv', 'missing.json');
    expect(() => assertWritablePrivateFileSync(target, 'marker')).not.toThrow();
  });

  it('refuses a symlinked target (ELOOP) with the supplied label', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, 'secret.json');
    const decoy = join(root, 'decoy.json');
    writeFileSync(decoy, '{}', { mode: 0o600 });
    symlinkSync(decoy, target);

    let caught: NodeJS.ErrnoException | undefined;
    try { assertWritablePrivateFileSync(target, 'config.json'); } catch (e) { caught = e as NodeJS.ErrnoException; }
    expect(caught?.code).toBe('ELOOP');
    expect(caught?.message).toBe('refusing to write config.json through symlink');
  });

  it('refuses a dangling target symlink instead of treating it as missing', () => {
    const root = makeTmp();
    const target = join(root, 'dangling.key');
    symlinkSync(join(root, 'missing.key'), target);

    let caught: NodeJS.ErrnoException | undefined;
    try { assertWritablePrivateFileSync(target, 'credential'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('ELOOP');
    expect(caught?.message).toBe('refusing to write credential through symlink');
  });

  it('refuses a non-regular target (EINVAL) with the supplied label', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'secret.json');
    mkdirSync(target, { recursive: true, mode: 0o700 });

    let caught: NodeJS.ErrnoException | undefined;
    try { assertWritablePrivateFileSync(target, 'marker'); } catch (e) { caught = e as NodeJS.ErrnoException; }
    expect(caught?.code).toBe('EINVAL');
    expect(caught?.message).toBe('refusing to write marker over non-regular path');
  });

  it('returns ok for a pre-existing regular file', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, 'real.json');
    writeFileSync(target, '{}', { mode: 0o600 });

    expect(() => assertWritablePrivateFileSync(target, 'marker')).not.toThrow();
  });

  it('defaults the label to "private file"', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, 'secret.json');
    const decoy = join(root, 'decoy.json');
    writeFileSync(decoy, '{}', { mode: 0o600 });
    symlinkSync(decoy, target);

    expect(() => assertWritablePrivateFileSync(target)).toThrow('refusing to write private file through symlink');
  });
});

describe('writePrivateJsonMarkerSync', () => {
  it('atomically writes a JSON marker at mode 0600 with a trailing newline', () => {
    const root = makeTmp();
    const markerPath = join(root, 'priv', 'state.marker');
    const value = { timestamp: '2026-06-28T00:00:00.000Z', cycles: 2 };

    writePrivateJsonMarkerSync(markerPath, value);

    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    const raw = readFileSync(markerPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(value);
  });

  it('overwrites an existing regular marker file', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const markerPath = join(dir, 'state.marker');
    writeFileSync(markerPath, 'old', { mode: 0o644 });

    writePrivateJsonMarkerSync(markerPath, { ok: true });

    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toEqual({ ok: true });
  });

  it('refuses to write through a symlinked target and leaves the decoy untouched', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const markerPath = join(dir, 'state.marker');
    const decoy = join(root, 'outside.json');
    writeFileSync(decoy, 'unchanged\n', { mode: 0o600 });
    symlinkSync(decoy, markerPath);

    let caught: NodeJS.ErrnoException | undefined;
    try { writePrivateJsonMarkerSync(markerPath, { x: 1 }); } catch (e) { caught = e as NodeJS.ErrnoException; }
    expect(caught?.code).toBe('ELOOP');
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(decoy, 'utf-8')).toBe('unchanged\n');
  });

  it('cleans up the temp file when the rename-time target assert fails', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const markerPath = join(dir, 'state.marker');

    vi.resetModules();
    let targetLstatCalls = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        lstatSync: vi.fn((p: string) => {
          if (p === markerPath) {
            targetLstatCalls += 1;
            // First target assert (pre-write): absent. Second assert
            // (post-write, pre-rename): a symlink raced into place.
            if (targetLstatCalls === 1) {
              const err = new Error('missing') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            }
            return { isSymbolicLink: () => true, isFile: () => false } as any;
          }
          return actual.lstatSync(p);
        }),
      };
    });
    const { writePrivateJsonMarkerSync: writeRacing } = await import('../../src/lib/private-fs.ts');

    expect(() => writeRacing(markerPath, { x: 1 })).toThrow(/through symlink/);
    // No leftover temp files in the directory.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('does not report failure after the atomic rename has published the new file', async () => {
    const root = makeTmp();
    const markerPath = join(root, 'priv', 'state.marker');

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        chmodSync: vi.fn((path: string, mode: number) => {
          if (path === markerPath) throw new Error('late target chmod failure');
          return actual.chmodSync(path, mode);
        }),
      };
    });
    const { writePrivateJsonMarkerSync: writeAtomic } = await import('../../src/lib/private-fs.ts');

    expect(() => writeAtomic(markerPath, { generation: 2 })).not.toThrow();
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({ generation: 2 });
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
  });

  it('reports a required directory fsync failure so callers do not elevate policy', async () => {
    const root = makeTmp();
    const markerPath = join(root, 'priv', 'state.marker');
    const directorySyncError = new Error('directory fsync unavailable');

    vi.resetModules();
    let fsyncCalls = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        fsyncSync: vi.fn((fd: number) => {
          fsyncCalls += 1;
          if (fsyncCalls === 2) throw directorySyncError;
          return actual.fsyncSync(fd);
        }),
      };
    });
    const { writePrivateJsonMarkerSync: writeAtomic } = await import('../../src/lib/private-fs.ts');
    const writeRequired = writeAtomic as unknown as (
      path: string,
      value: unknown,
      options: { directoryFsync: 'required' },
    ) => void;

    expect(() => writeRequired(markerPath, { generation: 3 }, { directoryFsync: 'required' }))
      .toThrow(directorySyncError);
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({ generation: 3 });
  });
});

describe('atomic private-file primitives', () => {
  it('refuses a pre-existing temp symlink without changing its target', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const decoy = join(root, 'decoy.key');
    const fixedId = 'fixed-temp-id';
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(decoy, 'unchanged', { mode: 0o600 });
    const tempPath = join(dir, `.credential.key.${process.pid}.${fixedId}.tmp`);
    symlinkSync(decoy, tempPath);

    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomUUID: () => fixedId,
    }));
    const { writeAtomicPrivateFileSync: writeWithFixedTemp } = await import('../../src/lib/private-fs.ts');

    let caught: NodeJS.ErrnoException | undefined;
    try { writeWithFixedTemp(target, 'replacement', 'credential'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EEXIST');
    expect(readFileSync(decoy, 'utf-8')).toBe('unchanged');
    expect(lstatSync(tempPath).isSymbolicLink()).toBe(true);
  });

  it('fsyncs the file before rename and the parent directory after rename', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const events: string[] = [];
    const openedPaths = new Map<number, string>();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      openSync: vi.fn((filePath: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: number) => {
        const fd = actual.openSync(filePath, flags, mode);
        openedPaths.set(fd, String(filePath));
        return fd;
      }),
      fsyncSync: vi.fn((fd: number) => {
        events.push(openedPaths.get(fd) === dir ? 'parent-fsync' : 'file-fsync');
        return actual.fsyncSync(fd);
      }),
      renameSync: vi.fn((from: string, to: string) => {
        events.push('rename');
        return actual.renameSync(from, to);
      }),
    }));
    const { writeAtomicPrivateFileSync: writeObserved } = await import('../../src/lib/private-fs.ts');

    writeObserved(target, 'credential', 'credential');

    expect(events).toEqual(['file-fsync', 'rename', 'parent-fsync']);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('removes its temp file when rename fails', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      renameSync: vi.fn(() => {
        throw new Error('simulated rename failure');
      }),
    }));
    const { writeAtomicPrivateFileSync: writeWithRenameFailure } = await import('../../src/lib/private-fs.ts');

    expect(() => writeWithRenameFailure(target, 'credential', 'credential')).toThrow(/simulated rename failure/);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not publish a target and removes its temp file when file fsync fails', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      fsyncSync: vi.fn(() => {
        throw new Error('simulated file fsync failure');
      }),
    }));
    const { writeAtomicPrivateFileSync: writeWithFsyncFailure } = await import('../../src/lib/private-fs.ts');

    expect(() => writeWithFsyncFailure(target, 'credential', 'credential')).toThrow(/simulated file fsync failure/);
    expect(actual.existsSync(target)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the default writer in-process: no child is spawned', async () => {
    const root = makeTmp();
    const target = join(root, 'priv', 'state.json');
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const spawnSyncSpy = vi.fn(actualChildProcess.spawnSync);

    vi.resetModules();
    vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawnSync: spawnSyncSpy }));
    const privateFs = await import('../../src/lib/private-fs.ts');

    privateFs.writeAtomicPrivateFileSync(target, 'payload', 'state');
    privateFs.writePrivateJsonMarkerSync(join(root, 'priv', 'marker.json'), { ok: true });

    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe('payload');
    // Control: the opt-in writer does spawn through the same spy.
    privateFs.writeAtomicPrivateFileIsolatedSync(join(root, 'priv', 'isolated.json'), 'payload', 'state');
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('isolated: fsyncs the file before rename and the parent directory after rename', async () => {
    // The mutations run in the isolated child; recorders in the child append
    // to an event log so the ordering is observed where it happens.
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const eventLog = join(root, 'atomic-order.events');
    const hookPath = join(root, 'atomic-order-hook.cjs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(hookPath, String.raw`
'use strict';
const fs = require('node:fs');
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
`, { mode: 0o600 });

    vi.resetModules();
    await mockChildWithHook(hookPath, { WHATSOUP_TEST_EVENT_LOG: eventLog });
    const { writeAtomicPrivateFileIsolatedSync: writeObserved } = await import('../../src/lib/private-fs.ts');

    writeObserved(target, 'credential', 'credential');

    const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    expect(events).toEqual(['file-fsync', 'rename', 'parent-fsync']);
    expect(readFileSync(target, 'utf8')).toBe('credential');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  }, 10_000);

  it('isolated: removes its temp file when rename fails', async () => {
    // The child reports a sanitized EIO instead of propagating its raw message.
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const hookPath = join(root, 'rename-fault-hook.cjs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(hookPath, String.raw`
'use strict';
const fs = require('node:fs');
fs.renameSync = function () {
  throw new Error('simulated rename failure');
};
`, { mode: 0o600 });

    vi.resetModules();
    await mockChildWithHook(hookPath);
    const { writeAtomicPrivateFileIsolatedSync: writeWithRenameFailure } = await import('../../src/lib/private-fs.ts');

    let caught: NodeJS.ErrnoException | undefined;
    try { writeWithRenameFailure(target, 'credential', 'credential'); } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('EIO');
    expect(caught?.message).not.toMatch(/simulated rename failure/);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 10_000);

  it('isolated: does not publish a target and removes its temp file when file fsync fails', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    const hookPath = join(root, 'fsync-fault-hook.cjs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(hookPath, String.raw`
'use strict';
const fs = require('node:fs');
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
`, { mode: 0o600 });

    vi.resetModules();
    await mockChildWithHook(hookPath);
    const { writeAtomicPrivateFileIsolatedSync: writeWithFsyncFailure } = await import('../../src/lib/private-fs.ts');

    let caught: NodeJS.ErrnoException | undefined;
    try { writeWithFsyncFailure(target, 'credential', 'credential'); } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('EIO');
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 10_000);

  it('isolated: binds replacement mutations to the opened directory across an ancestor exchange', async () => {
    // Exchange the target directory for a symlink to an outside directory at
    // the moment the temp file is opened. The seam fires on the parent's open
    // (the pre-delegation writer) and on the child's open (the delegated
    // writer), so the same exchange is exercised whichever process writes.
    const root = makeTmp();
    const dir = join(root, 'priv');
    const displaced = join(root, 'priv-displaced');
    const outside = join(root, 'outside');
    const target = join(dir, 'credential.key');
    const fixedId = 'atomic-ancestor-exchange';
    const tempName = `.credential.key.${process.pid}.${fixedId}.tmp`;
    const displacedTarget = join(displaced, 'credential.key');
    const outsideTarget = join(outside, 'credential.key');
    const hookPath = join(root, 'atomic-ancestor-exchange-hook.cjs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(target, 'original-target', { mode: 0o600 });
    writeFileSync(outsideTarget, 'outside-target', { mode: 0o640 });
    const originalTargetBefore = statSync(target);
    const outsideTargetBefore = statSync(outsideTarget);
    writeFileSync(hookPath, String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
`, { mode: 0o600 });
    const exchangeEnv = {
      WHATSOUP_ATOMIC_TEMP_NAME: tempName,
      WHATSOUP_ATOMIC_DIR: dir,
      WHATSOUP_ATOMIC_DISPLACED: displaced,
      WHATSOUP_ATOMIC_OUTSIDE: outside,
    };
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
    const child = await mockChildWithHook(hookPath, exchangeEnv);
    const privateFs = await import('../../src/lib/private-fs.ts');

    let caught: NodeJS.ErrnoException | undefined;
    try {
      privateFs.writeAtomicPrivateFileIsolatedSync(target, 'replacement', 'credential');
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    // The exchange must have happened, in one process or the other.
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    // Nothing is written through the decoy.
    expect(readFileSync(outsideTarget, 'utf8')).toBe('outside-target');
    expect(statSync(outsideTarget).ino).toBe(outsideTargetBefore.ino);
    expect(statSync(outsideTarget).mode & 0o777).toBe(0o640);
    expect(readdirSync(outside).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The write fails closed, and the original target is untouched.
    expect(caught?.code).toBe('ESTALE');
    expect(child.spawned()).toBe(true);
    expect(parentExchanged).toBe(false);
    expect(readFileSync(displacedTarget, 'utf8')).toBe('original-target');
    expect(statSync(displacedTarget).ino).toBe(originalTargetBefore.ino);
    expect(readdirSync(displaced).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 10_000);

  it('isolated: writes through a directory whose path crosses a pre-existing symlinked ancestor', () => {
    // Binding canonicalizes first, so a platform symlink already in the path
    // (for example /var -> /private/var on macOS) is not treated as an attack.
    const root = makeTmp();
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(join(real, 'priv'), { recursive: true, mode: 0o700 });
    symlinkSync(real, link);
    const target = join(link, 'priv', 'credential.key');

    writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential');

    expect(readFileSync(join(real, 'priv', 'credential.key'), 'utf8')).toBe('credential');
    expect(statSync(join(real, 'priv', 'credential.key')).mode & 0o777).toBe(0o600);
  }, 10_000);

  it('isolated: refuses a symlinked target directory without writing through it', () => {
    const root = makeTmp();
    const outside = join(root, 'outside');
    const link = join(root, 'priv');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, link);

    let caught: NodeJS.ErrnoException | undefined;
    try { writeAtomicPrivateFileIsolatedSync(join(link, 'credential.key'), 'credential', 'credential'); } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('ELOOP');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('isolated: classifies an invalid supervisor receipt as a sanitized transport failure', async () => {
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
    const privateFs = await import('../../src/lib/private-fs.ts');

    let caught: NodeJS.ErrnoException | undefined;
    try { privateFs.writeAtomicPrivateFileIsolatedSync(target, 'credential', 'credential'); } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('EIO');
    expect(String(caught?.message)).not.toContain('synthetic-private-invalid-frame');
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    ['valid', 'ETIMEDOUT', 'owned child exceeded its execution deadline'],
    ['corrupt', 'EOWNERDEAD', 'owned child process-group cleanup is uncertain'],
  ] as const)(
    'isolated: reaps the child process group when the supervisor hits the outer deadline (%s control frame)',
    async (controlMode, expectedCode, expectedMessage) => {
      // Stall the real supervisor after it has started a child that itself
      // spawns a SIGTERM-ignoring descendant, then let the outer spawnSync
      // timeout SIGKILL the supervisor. The parent must reap the detached
      // group from the fd-3 control frame, or report cleanup as uncertain.
      const root = makeTmp();
      const supervisorStatePath = join(root, 'supervisor.json');
      const descendantPidPath = join(root, 'descendant.pid');
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const hangingChildSource = String.raw`
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid), { flag: 'wx', mode: 0o600 });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        ...actualChildProcess,
        spawnSync: vi.fn((command: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding) => {
          const supervisorSource = args[2];
          if (typeof supervisorSource !== 'string' || !supervisorSource.includes('child.stdin.end(frame);')) {
            throw new Error('bounded supervisor source seam is unavailable');
          }
          const stalledSource = supervisorSource.replace('child.stdin.end(frame);', String.raw`
child.stdin.end(frame);
fs.writeFileSync(
  ${JSON.stringify(supervisorStatePath)},
  JSON.stringify({ supervisorPid: process.pid, childPid: child.pid }),
  { flag: 'wx', mode: 0o600 },
);
const testReadyDeadline = Date.now() + 1000;
const testReadyTimer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(descendantPidPath)})) {
    clearInterval(testReadyTimer);
    for (;;) {}
  }
  if (Date.now() >= testReadyDeadline) process.exit(70);
}, 1);
`);
          const result = actualChildProcess.spawnSync(command, [
            args[0], args[1], stalledSource, hangingChildSource, args[4], args[5],
          ], { ...options, timeout: 1_200, killSignal: 'SIGKILL' });
          const output = [...(result.output ?? [])];
          while (output.length < 4) output.push(null);
          if (controlMode === 'corrupt') {
            output[3] = Buffer.from('{"schemaVersion":1,"processGroupId":"private-invalid"}\n');
          }
          return { ...result, output };
        }),
      }));
      const privateFs = await import('../../src/lib/private-fs.ts');
      const target = join(root, 'priv', 'credential.key');

      let failure: NodeJS.ErrnoException | undefined;
      try { privateFs.writeAtomicPrivateFileIsolatedSync(target, 'private-payload', 'credential'); } catch (error) {
        failure = error as NodeJS.ErrnoException;
      }

      const state = JSON.parse(readFileSync(supervisorStatePath, 'utf8')) as { supervisorPid: number; childPid: number };
      const pids = [state.supervisorPid, state.childPid, Number(readFileSync(descendantPidPath, 'utf8'))];
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      };
      const aliveBeforeCleanup = pids.map(alive);
      // Test-owned cleanup so a failing assertion never leaks processes.
      for (const pid of [-state.childPid, ...pids]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* intentional: already gone */ }
      }

      expect(failure).toMatchObject({ name: 'BoundedProcessError', code: expectedCode, message: expectedMessage });
      expect(String(failure?.message)).not.toMatch(/SIGKILL|processGroupId|[0-9]{3,}|private-fs-test/);
      if (controlMode === 'valid') expect(aliveBeforeCleanup).toEqual([false, false, false]);
      expect(existsSync(target)).toBe(false);
    },
    10_000,
  );

  it('rejects a symlink read', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const decoy = join(root, 'decoy.key');
    const target = join(dir, 'symlink.key');
    writeFileSync(decoy, 'credential', { mode: 0o600 });
    symlinkSync(decoy, target);

    expect(() => readPrivateFileSync(target, { label: 'credential', maxBytes: 32 })).toThrow(/symlink/);
  });

  it('rejects a directory read', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'directory.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });

    expect(() => readPrivateFileSync(target, { label: 'credential', maxBytes: 32 })).toThrow(/non-regular/);
  });

  it('rejects a FIFO read without blocking', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'fifo.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    execFileSync('mkfifo', [target]);

    expect(() => readPrivateFileSync(target, { label: 'credential', maxBytes: 32 })).toThrow(/non-regular/);
  });

  it('rejects an oversized read', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'oversized.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(target, 'x'.repeat(33), { mode: 0o600 });

    expect(() => readPrivateFileSync(target, { label: 'credential', maxBytes: 32 })).toThrow(/maximum size/);
  });

  it('rejects a non-private file read', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'public.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(target, 'credential', { mode: 0o644 });

    expect(() => readPrivateFileSync(target, { label: 'credential', maxBytes: 32 })).toThrow(/non-private permissions/);
  });

  it('rejects a read through a symlinked directory', () => {
    const root = makeTmp();
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    mkdirSync(realDir, { mode: 0o700 });
    writeFileSync(join(realDir, 'credential.key'), 'credential', { mode: 0o600 });
    symlinkSync(realDir, linkDir, 'dir');

    expect(() => readPrivateFileSync(join(linkDir, 'credential.key'), { label: 'credential', maxBytes: 32 })).toThrow(/symlink/);
  });

  it('rejects a read through a non-private directory', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'credential.key'), 'credential', { mode: 0o600 });
    chmodSync(dir, 0o755);

    expect(() => readPrivateFileSync(join(dir, 'credential.key'), { label: 'credential', maxBytes: 32 })).toThrow(/non-private permissions/);
  });

  it('rejects a read through a foreign-owned directory with a sanitized EACCES error', async () => {
    setTestUid(1000);
    const dir = '/private-fixture/foreign-directory';
    const target = join(dir, 'credential.key');
    const { readPrivateFileSync: readForeignDirectory } = await importWithMockedOwnership(
      dir,
      target,
      2000,
      1000,
    );

    let caught: NodeJS.ErrnoException | undefined;
    try { readForeignDirectory(target, { label: 'credential', maxBytes: 32 }); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EACCES');
    expect(caught?.message).toBe('refusing to use credential directory not owned by current user');
    expect(caught?.message).not.toContain(target);
  });

  it('rejects a foreign-owned file read with a sanitized EACCES error', async () => {
    setTestUid(1000);
    const dir = '/private-fixture/owned-directory';
    const target = join(dir, 'credential.key');
    const { readPrivateFileSync: readForeignFile } = await importWithMockedOwnership(
      dir,
      target,
      1000,
      2000,
    );

    let caught: NodeJS.ErrnoException | undefined;
    try { readForeignFile(target, { label: 'credential', maxBytes: 32 }); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EACCES');
    expect(caught?.message).toBe('refusing to read credential not owned by current user');
    expect(caught?.message).not.toContain(target);
  });

  it('rejects deletion through a foreign-owned directory with a sanitized EACCES error', async () => {
    setTestUid(1000);
    const dir = '/private-fixture/foreign-delete-directory';
    const target = join(dir, 'credential.key');
    const { deletePrivateFileSync: deleteForeignDirectory } = await importWithMockedOwnership(
      dir,
      target,
      2000,
      1000,
    );

    let caught: NodeJS.ErrnoException | undefined;
    try { deleteForeignDirectory(target, 'credential'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EACCES');
    expect(caught?.message).toBe('refusing to use credential directory not owned by current user');
    expect(caught?.message).not.toContain(target);
  });

  it('rejects deletion of a foreign-owned file with a sanitized EACCES error', async () => {
    setTestUid(1000);
    const dir = '/private-fixture/owned-delete-directory';
    const target = join(dir, 'credential.key');
    const { deletePrivateFileSync: deleteForeignFile } = await importWithMockedOwnership(
      dir,
      target,
      1000,
      2000,
    );

    let caught: NodeJS.ErrnoException | undefined;
    try { deleteForeignFile(target, 'credential'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EACCES');
    expect(caught?.message).toBe('refusing to delete credential not owned by current user');
    expect(caught?.message).not.toContain(target);
  });

  it('fsyncs the parent directory after deleting a private file', async () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    const target = join(dir, 'credential.key');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(target, 'credential', { mode: 0o600 });
    const events: string[] = [];
    const openedPaths = new Map<number, string>();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      openSync: vi.fn((filePath: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: number) => {
        const fd = actual.openSync(filePath, flags, mode);
        openedPaths.set(fd, String(filePath));
        return fd;
      }),
      unlinkSync: vi.fn((filePath: string) => {
        events.push('unlink');
        return actual.unlinkSync(filePath);
      }),
      fsyncSync: vi.fn((fd: number) => {
        if (openedPaths.get(fd) === dir) events.push('parent-fsync');
        return actual.fsyncSync(fd);
      }),
    }));
    const { deletePrivateFileSync: deleteObserved } = await import('../../src/lib/private-fs.ts');

    expect(deleteObserved(target, 'credential')).toBe(true);
    expect(events).toEqual(['unlink', 'parent-fsync']);
    expect(actual.existsSync(target)).toBe(false);
  });
});

describe('readFreshMarkerSync', () => {
  it('returns null when the marker file is missing', () => {
    const root = makeTmp();
    expect(readFreshMarkerSync(join(root, 'absent.marker'), 5 * 60 * 1000)).toBeNull();
  });

  it('returns the parsed marker when it is within the freshness window', () => {
    const root = makeTmp();
    const markerPath = join(root, 'fresh.marker');
    const value = { timestamp: new Date().toISOString(), cycles: 3 };
    writeFileSync(markerPath, JSON.stringify(value), { mode: 0o600 });

    const result = readFreshMarkerSync<typeof value>(markerPath, 5 * 60 * 1000);
    expect(result).toEqual(value);
  });

  it('returns null when the marker is older than maxAgeMs', () => {
    const root = makeTmp();
    const markerPath = join(root, 'stale.marker');
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify({ timestamp: old }), { mode: 0o600 });

    expect(readFreshMarkerSync(markerPath, 5 * 60 * 1000)).toBeNull();
  });

  it('returns null when the timestamp is missing or unparseable (non-finite age)', () => {
    const root = makeTmp();
    const markerPath = join(root, 'noisy.marker');
    writeFileSync(markerPath, JSON.stringify({ cycles: 1 }), { mode: 0o600 });

    expect(readFreshMarkerSync(markerPath, 5 * 60 * 1000)).toBeNull();
  });

  it('returns null (never throws) when the marker is corrupt JSON', () => {
    const root = makeTmp();
    const markerPath = join(root, 'corrupt.marker');
    writeFileSync(markerPath, '{not json', { mode: 0o600 });

    expect(readFreshMarkerSync(markerPath, 5 * 60 * 1000)).toBeNull();
  });

  it('treats ageMs exactly equal to maxAgeMs as stale (exclusive upper bound)', () => {
    const root = makeTmp();
    const markerPath = join(root, 'edge.marker');
    const now = new Date('2026-06-28T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ts = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify({ timestamp: ts }), { mode: 0o600 });

    expect(readFreshMarkerSync(markerPath, 5 * 60 * 1000)).toBeNull();
    vi.useRealTimers();
  });
});
