import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPrivateDirectorySync,
  ensurePrivateDirectorySync,
  forceEnsurePrivateDirectorySync,
  writePrivateFileSync,
} from '../../src/lib/private-fs.ts';

let tmpRoot = '';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'private-fs-test-'));
  return tmpRoot;
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
