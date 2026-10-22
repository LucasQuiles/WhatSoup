import { createHash } from 'node:crypto';
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPrivateConfigFileSync } from '../../src/core/private-config-file.ts';
import { readPrivateFileSync } from '../../src/lib/private-fs.ts';

const roots: string[] = [];

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'private-observation-')));
  roots.push(root);
  const dir = join(root, 'inputs');
  mkdirSync(dir, { mode: 0o700 });
  const target = join(dir, 'config.json');
  const bytes = Buffer.from('{"name":"synthetic","value":"é"}\r\n');
  writeFileSync(target, bytes, { mode: 0o600 });
  return { root, dir, target, bytes, options: { maxBytes: 128, observation: { root } } };
}

async function duringRead(change: () => void) {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let changed = false;
  vi.resetModules();
  vi.doMock('node:fs', () => ({
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args);
      if (!changed) {
        changed = true;
        change();
      }
      return count;
    },
  }));
  return (await import('../../src/lib/private-fs.ts')).readPrivateFileSync;
}

describe('private file observations', () => {
  it('returns exact bytes, their digest and stable identity without changing the file', () => {
    const f = fixture();
    const before = statSync(f.target);
    const precise = statSync(f.target, { bigint: true });
    const result = readPrivateFileSync(f.target, f.options);
    expect(result).toEqual({
      bytes: f.bytes,
      rawSha256: createHash('sha256').update(f.bytes).digest('hex'),
      identity: {
        device: String(before.dev), inode: String(before.ino), size: before.size,
        mode: before.mode, uid: before.uid, links: before.nlink,
        modifiedNs: String(precise.mtimeNs), changedNs: String(precise.ctimeNs),
      },
    });
    const after = statSync(f.target);
    expect([after.ino, after.mode, after.size, after.mtimeMs, after.ctimeMs])
      .toEqual([before.ino, before.mode, before.size, before.mtimeMs, before.ctimeMs]);
    expect(readFileSync(f.target)).toEqual(f.bytes);
    expect(readPrivateFileSync(f.target, { maxBytes: 128 })).toBe(f.bytes.toString('utf8'));
  });

  it('preserves the legacy 0644 config load while rejecting it for observation', () => {
    const f = fixture();
    chmodSync(f.target, 0o644);
    expect(readPrivateConfigFileSync(f.target)).toBe(f.bytes.toString('utf8'));
    expect(() => readPrivateFileSync(f.target, f.options)).toThrow(/non-private permissions/);
    expect(statSync(f.target).mode & 0o777).toBe(0o644);
  });

  it('rejects a hard link even when the linked file is private', () => {
    const f = fixture();
    linkSync(f.target, join(f.dir, 'alias.json'));
    expect(() => readPrivateFileSync(f.target, f.options)).toThrow(/hard link/);
  });

  it('rejects symlinks at the trusted root, an ancestor, and the file', () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.dir, alias);
    expect(() => readPrivateFileSync(join(alias, 'config.json'), {
      maxBytes: 128, observation: { root: alias },
    })).toThrow(/symlink/);
    expect(() => readPrivateFileSync(join(alias, 'config.json'), f.options)).toThrow(/symlink/);
    const leaf = join(f.dir, 'leaf.json');
    symlinkSync(f.target, leaf);
    expect(() => readPrivateFileSync(leaf, f.options)).toThrow(/symlink/);
  });

  it('rejects an unsafe trusted ancestor even when the immediate parent is private', () => {
    const f = fixture();
    chmodSync(f.root, 0o755);
    expect(() => readPrivateFileSync(f.target, f.options)).toThrow(/non-private permissions/);
    expect(statSync(f.root).mode & 0o777).toBe(0o755);
  });

  it('rejects a foreign owner instead of observing on behalf of a different user', () => {
    const f = fixture();
    const uid = statSync(f.root).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    expect(() => readPrivateFileSync(f.target, f.options)).toThrow(/owned by current user/);
  });

  it('rejects escapes and non-canonical path components', () => {
    const f = fixture();
    expect(() => readPrivateFileSync(f.target, {
      maxBytes: 128, observation: { root: join(f.root, 'other') },
    })).toThrow(/observation root/);
    expect(() => readPrivateFileSync(`${f.dir}/../inputs/config.json`, f.options))
      .toThrow(/canonical absolute/);
    expect(() => readPrivateFileSync('config.json', f.options)).toThrow(/canonical absolute/);
  });

  it('keeps the size bound and returns no observation for an absent file', () => {
    const f = fixture();
    expect(() => readPrivateFileSync(f.target, { ...f.options, maxBytes: 4 }))
      .toThrow(/maximum size/);
    expect(readPrivateFileSync(join(f.dir, 'absent.json'), f.options)).toBeNull();
  });

  it('detects replacement between lstat and open even when replacement bytes match', async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      openSync: (path: string, flags: number) => {
        if (path === f.target) {
          renameSync(f.target, join(f.dir, 'original.json'));
          writeFileSync(f.target, f.bytes, { mode: 0o600 });
        }
        return actual.openSync(path, flags);
      },
    }));
    const observedRead = (await import('../../src/lib/private-fs.ts')).readPrivateFileSync;
    expect(() => observedRead(f.target, f.options)).toThrow(/changed/);
  });

  it('detects a replacement during the descriptor read', async () => {
    const f = fixture();
    const observedRead = await duringRead(() => {
      renameSync(f.target, join(f.dir, 'original.json'));
      writeFileSync(f.target, f.bytes, { mode: 0o600 });
    });
    expect(() => observedRead(f.target, f.options)).toThrow(/changed/);
  });

  it('detects an in-place content change during the descriptor read', async () => {
    const f = fixture();
    const observedRead = await duringRead(() => writeFileSync(f.target, 'changed'));
    expect(() => observedRead(f.target, f.options)).toThrow(/changed/);
  });

  it('detects a same-length rewrite without relying on the file size', async () => {
    const f = fixture();
    const replacement = Buffer.from(f.bytes);
    replacement[replacement.indexOf('synthetic')] = 'S'.charCodeAt(0);
    const before = statSync(f.target, { bigint: true });
    const observedRead = await duringRead(() => writeFileSync(f.target, replacement));
    expect(() => observedRead(f.target, f.options)).toThrow(/changed/);
    const after = statSync(f.target, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect([after.mtimeNs, after.ctimeNs]).not.toEqual([before.mtimeNs, before.ctimeNs]);
    expect(readFileSync(f.target)).toEqual(replacement);
  });

  it('detects replacement of the containing directory', async () => {
    const f = fixture();
    const observedRead = await duringRead(() => {
      renameSync(f.dir, join(f.root, 'original-inputs'));
      mkdirSync(f.dir, { mode: 0o700 });
      writeFileSync(f.target, f.bytes, { mode: 0o600 });
    });
    expect(() => observedRead(f.target, f.options)).toThrow(/changed/);
  });

  it('rejects permissions changed during the read', async () => {
    const f = fixture();
    const observedRead = await duringRead(() => chmodSync(f.target, 0o644));
    expect(() => observedRead(f.target, f.options)).toThrow(/non-private permissions|changed/);
  });
});
