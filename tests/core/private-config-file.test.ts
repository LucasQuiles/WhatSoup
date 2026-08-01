import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  mutatePrivateConfigFileSync,
  privateConfigLockPath,
  readPrivateConfigFileSync,
  withPrivateConfigLockSync,
  writePrivateConfigFileSync,
} from '../../src/core/private-config-file.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  vi.resetModules();
});

function makeTempDir(): string {
  return tmp.make('whatsoup-private-config');
}

function makeConfigFile(body = '{"ok":false}\n'): string {
  const dir = makeTempDir();
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, body, { mode: 0o644 });
  return configPath;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('private config file helpers', () => {
  it('removes a regular legacy tmp file before atomically replacing config.json', () => {
    const configPath = makeConfigFile('old\n');
    const legacyTmp = `${configPath}.tmp`;
    writeFileSync(legacyTmp, 'legacy\n', { mode: 0o600 });

    writePrivateConfigFileSync(configPath, 'new\n');

    expect(readFileSync(configPath, 'utf-8')).toBe('new\n');
    expect(mode(configPath)).toBe(0o600);
    expect(existsSync(legacyTmp)).toBe(false);
  });

  it('refuses unsafe legacy tmp paths before writing', () => {
    const symlinkedConfig = makeConfigFile('old\n');
    const symlinkedTmp = `${symlinkedConfig}.tmp`;
    const symlinkTarget = join(makeTempDir(), 'decoy.tmp');
    writeFileSync(symlinkTarget, 'decoy\n');
    symlinkSync(symlinkTarget, symlinkedTmp);

    expect(() => writePrivateConfigFileSync(symlinkedConfig, 'new\n')).toThrow(/symlinked tmp path/);
    expect(readFileSync(symlinkedConfig, 'utf-8')).toBe('old\n');

    const dirConfig = makeConfigFile('old\n');
    mkdirSync(`${dirConfig}.tmp`);

    expect(() => writePrivateConfigFileSync(dirConfig, 'new\n')).toThrow(/non-regular path/);
    expect(readFileSync(dirConfig, 'utf-8')).toBe('old\n');
  });

  it('reads through the private open path and refuses a symlinked config file', () => {
    const configPath = makeConfigFile('{"ok":true}\n');
    expect(readPrivateConfigFileSync(configPath)).toBe('{"ok":true}\n');

    const symlinkDir = makeTempDir();
    const target = join(symlinkDir, 'target.json');
    const link = join(symlinkDir, 'config.json');
    writeFileSync(target, '{"ok":false}\n');
    symlinkSync(target, link);

    expect(() => readPrivateConfigFileSync(link)).toThrow(/through symlink/);
  });

  it('releases the mutation lock when the callback throws', () => {
    const configPath = makeConfigFile('{"ok":false}\n');
    const lockPath = privateConfigLockPath(configPath);

    expect(() => withPrivateConfigLockSync(configPath, () => {
      throw new Error('callback failed');
    })).toThrow(/callback failed/);

    expect(existsSync(lockPath)).toBe(false);
    expect(withPrivateConfigLockSync(configPath, () => 'reacquired')).toBe('reacquired');
  });

  it('mutates in place when the callback returns void', () => {
    const configPath = makeConfigFile('{"name":"agent","introSent":false}\n');

    const next = mutatePrivateConfigFileSync(configPath, (raw) => {
      raw.introSent = true;
    });

    expect(next).toMatchObject({ name: 'agent', introSent: true });
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({ introSent: true });
    expect(mode(configPath)).toBe(0o600);
  });

  it('cleans up and closes when a post-open write fstat race finds a non-file', async () => {
    const closeSyncMock = vi.fn();
    const unlinkSyncMock = vi.fn(() => {
      throw new Error('tmp removal failed');
    });
    const fd = 42;
    const root = '/tmp/private-config-fstat-race';
    const configPath = `${root}/config.json`;

    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        lstatSync: vi.fn((path: string) => {
          if (path === root) return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
          if (path === configPath) return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
          const err = new Error('missing') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
        openSync: vi.fn(() => fd),
        fstatSync: vi.fn(() => ({ isFile: () => false })),
        closeSync: closeSyncMock,
        unlinkSync: unlinkSyncMock,
      };
    });
    const { writePrivateConfigFileSync: writeWithRacedFstat } = await import('../../src/core/private-config-file.ts');

    expect(() => writeWithRacedFstat(configPath, '{}\n')).toThrow(/non-regular path/);
    expect(closeSyncMock).toHaveBeenCalledWith(fd);
    expect(unlinkSyncMock).toHaveBeenCalledWith(`${root}/.config.json.${process.pid}.123.8.tmp`);
  });

  it('closes when a post-open read fstat race finds a non-file', async () => {
    const closeSyncMock = vi.fn();
    const readFileSyncMock = vi.fn();
    const fd = 43;
    const root = '/tmp/private-config-read-race';
    const configPath = `${root}/config.json`;

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        lstatSync: vi.fn((path: string) => {
          if (path === root) return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
          if (path === configPath) return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
          throw new Error(`unexpected lstat: ${path}`);
        }),
        openSync: vi.fn(() => fd),
        fstatSync: vi.fn(() => ({ isFile: () => false })),
        readFileSync: readFileSyncMock,
        closeSync: closeSyncMock,
      };
    });
    const { readPrivateConfigFileSync: readWithRacedFstat } = await import('../../src/core/private-config-file.ts');

    expect(() => readWithRacedFstat(configPath)).toThrow(/non-regular path/);
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(closeSyncMock).toHaveBeenCalledWith(fd);
  });

  it('refuses a config path whose parent is not a real directory', () => {
    const root = makeTempDir();
    const parentFile = join(root, 'not-dir');
    writeFileSync(parentFile, 'not a directory');

    expect(() => writePrivateConfigFileSync(join(parentFile, 'config.json'), '{}\n')).toThrow(/non-directory path/);

    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'config.json'), '{}\n');
    symlinkSync(realDir, linkDir);

    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
    expect(() => writePrivateConfigFileSync(join(linkDir, 'config.json'), '{}\n')).toThrow(/directory through symlink/);
  });
});
