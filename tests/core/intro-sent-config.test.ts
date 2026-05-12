import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistIntroSentFlag } from '../../src/core/intro-sent-config.ts';

function fileMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('persistIntroSentFlag', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-intro-sent-'));
    tempDirs.push(dir);
    return dir;
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
});
