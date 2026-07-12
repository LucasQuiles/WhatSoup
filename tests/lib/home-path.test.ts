import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  expandHomePath,
  hasUnsupportedTildePrefix,
  isSamePhysicalDirectory,
} from '../../src/lib/home-path.ts';

describe('expandHomePath', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHomePath('~')).toBe(os.homedir());
  });

  it('expands ~/foo to the home directory joined with foo', () => {
    expect(expandHomePath('~/foo')).toBe(path.join(os.homedir(), 'foo'));
  });

  it('expands ~/foo/bar to the home directory joined with foo/bar', () => {
    expect(expandHomePath('~/foo/bar')).toBe(path.join(os.homedir(), 'foo/bar'));
  });

  it('expands a trailing slash form ~/ to the home directory', () => {
    expect(path.normalize(expandHomePath('~/'))).toBe(path.normalize(os.homedir()));
  });

  it('returns absolute paths unchanged', () => {
    expect(expandHomePath('/abs/path')).toBe('/abs/path');
  });

  it('trims surrounding whitespace before returning a non-tilde path', () => {
    expect(expandHomePath('  /abs/path  ')).toBe('/abs/path');
  });

  it('returns relative paths unchanged after trimming (validation is the caller\'s job)', () => {
    expect(expandHomePath('relative/path')).toBe('relative/path');
  });

  it('does not expand other-user tildes like ~user/foo', () => {
    expect(expandHomePath('~user/foo')).toBe('~user/foo');
  });

  it('returns an empty string when given an empty string', () => {
    expect(expandHomePath('')).toBe('');
  });

  it('trims whitespace-only input to an empty string', () => {
    expect(expandHomePath('   ')).toBe('');
  });
});

describe('hasUnsupportedTildePrefix', () => {
  it('flags ~user/foo as unsupported', () => {
    expect(hasUnsupportedTildePrefix('~user/foo')).toBe(true);
  });

  it('flags ~root as unsupported', () => {
    expect(hasUnsupportedTildePrefix('~root')).toBe(true);
  });

  it('does not flag ~/foo as unsupported', () => {
    expect(hasUnsupportedTildePrefix('~/foo')).toBe(false);
  });

  it('does not flag a bare ~ as unsupported', () => {
    expect(hasUnsupportedTildePrefix('~')).toBe(false);
  });

  it('does not flag ~/ as unsupported', () => {
    expect(hasUnsupportedTildePrefix('~/')).toBe(false);
  });

  it('does not flag absolute paths as unsupported', () => {
    expect(hasUnsupportedTildePrefix('/abs')).toBe(false);
  });

  it('does not flag relative paths as unsupported', () => {
    expect(hasUnsupportedTildePrefix('relative')).toBe(false);
  });

  it('does not flag empty strings as unsupported', () => {
    expect(hasUnsupportedTildePrefix('')).toBe(false);
  });

  it('trims whitespace before checking the prefix', () => {
    expect(hasUnsupportedTildePrefix('  ~user/foo  ')).toBe(true);
  });
});

describe('isSamePhysicalDirectory', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-path-identity-'));
    roots.push(root);
    return root;
  }

  it('recognizes a symlink alias to the same directory', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const alias = path.join(root, 'home-alias');
    fs.mkdirSync(home);
    fs.symlinkSync(home, alias);

    expect(isSamePhysicalDirectory(alias, home)).toBe(true);
  });

  it('keeps a real child and a symlink alias to that child distinct from home', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(home, 'workspace');
    const alias = path.join(home, 'workspace-alias');
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(workspace, alias);

    expect(isSamePhysicalDirectory(workspace, home)).toBe(false);
    expect(isSamePhysicalDirectory(alias, home)).toBe(false);
  });

  it('keeps a new child distinct when its nearest existing parent is readable', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    expect(isSamePhysicalDirectory(path.join(home, 'new-workspace'), home)).toBe(false);
  });

  it('fails closed when the candidate is an existing regular file', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const file = path.join(home, 'not-a-workspace');
    fs.mkdirSync(home);
    fs.writeFileSync(file, 'not a directory');

    expect(() => isSamePhysicalDirectory(file, home)).toThrow(/determine physical directory identity/i);
  });

  it('fails closed when the candidate is a symlink to a regular file', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const file = path.join(home, 'not-a-workspace');
    const alias = path.join(home, 'not-a-workspace-alias');
    fs.mkdirSync(home);
    fs.writeFileSync(file, 'not a directory');
    fs.symlinkSync(file, alias);

    expect(() => isSamePhysicalDirectory(alias, home)).toThrow(/determine physical directory identity/i);
  });

  it('fails closed when a dangling symlink makes physical identity ambiguous', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const dangling = path.join(home, 'dangling-workspace');
    fs.mkdirSync(home);
    fs.symlinkSync(path.join(root, 'missing-target'), dangling);

    expect(() => isSamePhysicalDirectory(dangling, home)).toThrow(/determine physical directory identity/i);
  });
});
