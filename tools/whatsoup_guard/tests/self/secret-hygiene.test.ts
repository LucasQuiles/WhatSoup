import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSelfSecrets } from '../../src/self/secret-hygiene.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-secret-'));
  dirs.push(dir);
  return dir;
}

function secretFile(mode: number): string {
  const path = join(tempDir(), 'secret');
  writeFileSync(path, 'secret', { mode });
  chmodSync(path, mode);
  return path;
}

describe('checkSelfSecrets', () => {
  it('reports ok when every declared secret is at expected mode', () => {
    const first = secretFile(0o600);
    const second = secretFile(0o400);

    const result = checkSelfSecrets([
      { path: first, mode: 0o600 },
      { path: second, mode: 0o400 },
    ]);

    expect(result).toEqual({ ok: true, widened: [] });
  });

  it('reports each widened secret', () => {
    const file = secretFile(0o644);

    const result = checkSelfSecrets([{ path: file, mode: 0o600 }]);

    expect(result).toEqual({
      ok: false,
      widened: [{ path: file, expectedMode: 0o600, actualMode: 0o644 }],
    });
  });

  it('accepts stricter-than-expected mode', () => {
    const file = secretFile(0o400);

    const result = checkSelfSecrets([{ path: file, mode: 0o600 }]);

    expect(result).toEqual({ ok: true, widened: [] });
  });

  it('reports nonexistent files as missing', () => {
    const missing = join(tempDir(), 'missing-secret');

    const result = checkSelfSecrets([{ path: missing, mode: 0o600 }]);

    expect(result).toEqual({
      ok: false,
      widened: [{ path: missing, expectedMode: 0o600, actualMode: -1 }],
    });
  });

  it('reports directories as invalid secret targets', () => {
    const dir = join(tempDir(), 'secret-dir');
    mkdirSync(dir, { mode: 0o700 });

    const result = checkSelfSecrets([{ path: dir, mode: 0o700 }]);

    expect(result).toEqual({
      ok: false,
      widened: [{ path: dir, expectedMode: 0o700, actualMode: -2 }],
    });
  });

  it('reports symlinks as invalid secret targets without following them', () => {
    const target = secretFile(0o600);
    const link = join(tempDir(), 'secret-link');
    symlinkSync(target, link);

    const result = checkSelfSecrets([{ path: link, mode: 0o600 }]);

    expect(result).toEqual({
      ok: false,
      widened: [{ path: link, expectedMode: 0o600, actualMode: -3 }],
    });
  });
});
