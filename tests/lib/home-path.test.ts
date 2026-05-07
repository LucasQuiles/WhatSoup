import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

import { expandHomePath, hasUnsupportedTildePrefix } from '../../src/lib/home-path.ts';

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
