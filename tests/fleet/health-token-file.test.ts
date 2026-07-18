import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPrivateHealthTokenFileSync } from '../../src/fleet/health-token-file.ts';

const canonicalToken = 'a'.repeat(64);
const canonicalContents = `WHATSOUP_HEALTH_TOKEN=${canonicalToken}\n`;
const tempDirs: string[] = [];

function makeFixture(contents = canonicalContents): { instanceDir: string; tokenPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-health-token-file-'));
  tempDirs.push(root);
  const instanceDir = path.join(root, 'instance');
  fs.mkdirSync(instanceDir, { mode: 0o700 });
  const tokenPath = path.join(instanceDir, 'tokens.env');
  fs.writeFileSync(tokenPath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(instanceDir, 0o700);
  fs.chmodSync(tokenPath, 0o600);
  return { instanceDir, tokenPath };
}

function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return String(err);
  }
  throw new Error('expected function to throw');
}

function withStatValue<T extends fs.Stats>(
  stat: T,
  property: 'ino' | 'uid',
  value: number,
): T {
  return new Proxy(stat, {
    get(source, candidate, receiver) {
      if (candidate === property) return value;
      const member = Reflect.get(source, candidate, receiver);
      return typeof member === 'function' ? member.bind(source) : member;
    },
  });
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readPrivateHealthTokenFileSync', () => {
  it('reads an exact canonical token from a private file and directory', () => {
    const { tokenPath } = makeFixture();

    expect(readPrivateHealthTokenFileSync(tokenPath)).toBe(canonicalToken);
  });

  it('returns null only when the token file is absent', () => {
    const { tokenPath } = makeFixture();
    fs.unlinkSync(tokenPath);

    expect(readPrivateHealthTokenFileSync(tokenPath)).toBeNull();
  });

  it('rejects a symlinked token file without disclosing its target value', () => {
    const { instanceDir, tokenPath } = makeFixture();
    const targetPath = path.join(instanceDir, 'target.env');
    fs.renameSync(tokenPath, targetPath);
    fs.symlinkSync(targetPath, tokenPath);

    const message = errorText(() => readPrivateHealthTokenFileSync(tokenPath));

    expect(message).toMatch(/symlink/i);
    expect(message).not.toContain(canonicalToken);
  });

  it('rejects a final-component symlink swapped in after lstat', async () => {
    const { instanceDir, tokenPath } = makeFixture();
    const originalPath = path.join(instanceDir, 'original.env');
    const replacementToken = 'b'.repeat(64);
    const replacementPath = path.join(instanceDir, 'replacement.env');
    fs.writeFileSync(
      replacementPath,
      `WHATSOUP_HEALTH_TOKEN=${replacementToken}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    let swapped = false;
    let openedFlags = 0;

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...realFs,
        openSync: (candidate: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
          if (String(candidate) === tokenPath && !swapped) {
            swapped = true;
            openedFlags = typeof flags === 'number' ? flags : 0;
            realFs.renameSync(tokenPath, originalPath);
            realFs.symlinkSync(replacementPath, tokenPath);
          }
          return realFs.openSync(candidate, flags, mode);
        },
      };
    });
    const { readPrivateHealthTokenFileSync: readAfterSwap } = await import(
      '../../src/fleet/health-token-file.ts'
    );

    const message = errorText(() => readAfterSwap(tokenPath));

    expect(swapped).toBe(true);
    expect(openedFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(openedFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
    expect(message).not.toContain(replacementToken);
  });

  it('rejects a post-open inode mismatch from fstat and closes the descriptor', async () => {
    const { tokenPath } = makeFixture();
    let closeCount = 0;

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...realFs,
        fstatSync: (fd: number) => {
          const stat = realFs.fstatSync(fd);
          return withStatValue(stat, 'ino', stat.ino + 1);
        },
        closeSync: (fd: number) => {
          closeCount += 1;
          realFs.closeSync(fd);
        },
      };
    });
    const { readPrivateHealthTokenFileSync: readWithRacedFstat } = await import(
      '../../src/fleet/health-token-file.ts'
    );

    expect(() => readWithRacedFstat(tokenPath)).toThrow(/changed while it was being opened/i);
    expect(closeCount).toBe(1);
  });

  it('rejects an immediate directory symlink without reading the token', () => {
    const { instanceDir, tokenPath } = makeFixture();
    const root = path.dirname(instanceDir);
    const linkDir = path.join(root, 'linked-instance');
    fs.symlinkSync(instanceDir, linkDir);

    const message = errorText(() => readPrivateHealthTokenFileSync(
      path.join(linkDir, path.basename(tokenPath)),
    ));

    expect(message).toMatch(/directory.*symlink/i);
    expect(message).not.toContain(canonicalToken);
  });

  it('rejects a token file whose mode is not exactly 0600', () => {
    const { tokenPath } = makeFixture();
    fs.chmodSync(tokenPath, 0o640);

    expect(() => readPrivateHealthTokenFileSync(tokenPath)).toThrow(/mode 0600/i);
  });

  it.each([0o770, 0o702])(
    'rejects an immediate directory with unsafe mode %s',
    (unsafeMode) => {
      const { instanceDir, tokenPath } = makeFixture();
      fs.chmodSync(instanceDir, unsafeMode);

      expect(() => readPrivateHealthTokenFileSync(tokenPath)).toThrow(/group- or world-writable/i);
    },
  );

  it('rejects a non-regular token path', () => {
    const { tokenPath } = makeFixture();
    fs.unlinkSync(tokenPath);
    fs.mkdirSync(tokenPath, { mode: 0o700 });

    expect(() => readPrivateHealthTokenFileSync(tokenPath)).toThrow(/non-regular/i);
  });

  it('rejects malformed exact content without disclosing the credential value', () => {
    const malformedValue = 'sensitive-but-not-canonical';
    const { tokenPath } = makeFixture(`WHATSOUP_HEALTH_TOKEN=${malformedValue}\n`);

    const message = errorText(() => readPrivateHealthTokenFileSync(tokenPath));

    expect(message).toMatch(/exactly one canonical/i);
    expect(message).not.toContain(malformedValue);
  });

  it.each([
    ['file', 'health token file must be owned by the current uid'],
    ['directory', 'health token directory must be owned by the current uid'],
  ] as const)(
    'rejects the wrong %s owner without logging metadata derived from the token',
    async (target, expected) => {
      const { instanceDir, tokenPath } = makeFixture();
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const wrongUid = actualFs.statSync(instanceDir).uid + 1;

      vi.resetModules();
      vi.doMock('node:fs', async () => {
        const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...realFs,
          lstatSync: (candidate: fs.PathLike, options?: fs.StatOptions) => {
            const stat = realFs.lstatSync(candidate, options as never);
            const matches = target === 'file'
              ? String(candidate) === tokenPath
              : String(candidate) === instanceDir;
            if (!matches) return stat;
            return withStatValue(stat, 'uid', wrongUid);
          },
        };
      });
      const { readPrivateHealthTokenFileSync: readWithWrongOwner } = await import(
        '../../src/fleet/health-token-file.ts'
      );

      const message = errorText(() => readWithWrongOwner(tokenPath));

      expect(message).toContain(expected);
      expect(message).not.toContain(canonicalToken);
    },
  );
});
