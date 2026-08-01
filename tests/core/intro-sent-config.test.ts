import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistIntroSentFlag } from '../../src/core/intro-sent-config.ts';
import { privateConfigLockPath } from '../../src/core/private-config-file.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

function fileMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('persistIntroSentFlag', () => {
  const tmp = trackTmpDirs('');

  function makeTempDir(): string {
    return tmp.make('whatsoup-intro-sent');
  }

  it('tightens config.json to private mode when persisting introSent', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ name: 'agent', introSent: false }, null, 2) + '\n');
    chmodSync(configPath, 0o644);
    expect(fileMode(configPath)).toBe(0o644);

    persistIntroSentFlag(configPath, true);

    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({ introSent: true });
    expect(fileMode(configPath)).toBe(0o600);
  });

  it('refuses to write config.json through a symlink', () => {
    const dir = makeTempDir();
    const targetPath = join(dir, 'target.json');
    const configPath = join(dir, 'config.json');
    writeFileSync(targetPath, JSON.stringify({ introSent: false }, null, 2) + '\n');
    symlinkSync(targetPath, configPath);

    expect(() => persistIntroSentFlag(configPath, true)).toThrow(/symlink/);
  });

  it('refuses to write config.json over a non-regular path', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.json');
    mkdirSync(configPath);

    expect(() => persistIntroSentFlag(configPath, true)).toThrow(/non-regular/);
  });

  it('refuses to write config.json through a symlinked parent directory', () => {
    const root = makeTempDir();
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    const configPath = join(linkDir, 'config.json');
    writeFileSync(join(realDir, 'config.json'), JSON.stringify({ introSent: false }, null, 2) + '\n');

    expect(() => persistIntroSentFlag(configPath, true)).toThrow(/symlink/);
  });

  it('leaves config.json unchanged when JSON parsing fails', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.json');
    const lockPath = privateConfigLockPath(configPath);
    const original = '{not-json\n';
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o644);

    expect(() => persistIntroSentFlag(configPath, true)).toThrow();

    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(fileMode(configPath)).toBe(0o644);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails closed while another writer owns the config mutation lock', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ name: 'agent', introSent: false }, null, 2) + '\n');
    chmodSync(configPath, 0o600);
    const lock = acquireProcessLock(privateConfigLockPath(configPath), { token: 'held-config-lock' });

    try {
      expect(() => persistIntroSentFlag(configPath, true)).toThrow(/process lock active/);
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({ introSent: false });
    } finally {
      releaseProcessLock(lock);
    }
  });

  it('leaves config.json unchanged when the private temp write cannot start', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ name: 'agent', introSent: false }, null, 2) + '\n');
    chmodSync(configPath, 0o600);
    chmodSync(dir, 0o500);

    try {
      expect(() => persistIntroSentFlag(configPath, true)).toThrow();
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({ introSent: false });
      expect(fileMode(configPath)).toBe(0o600);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
