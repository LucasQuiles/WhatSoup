import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir as systemTmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { trackTmpDirs } from './tmp-dir.ts';

const tmp = trackTmpDirs('tmp-dir-helper-');

// Fixture parent for the options.base coverage below: created once, at file
// scope (trackTmpDirs() must be called at file scope, not inside it() — see
// tmp-dir.ts), under a realpath-canonical parent so the assertions below
// aren't sensitive to the host's own os.tmpdir()-canonicalization quirks
// (e.g. macOS's /var -> /private/var symlink). trackTmpDirs()'s own
// cleanup() only removes the leaf dirs it made under this base, never the
// base itself, so it is swept manually in the afterAll below.
const customBase = mkdtempSync(join(realpathSync(systemTmpdir()), 'tmp-dir-helper-base-parent-'));
const tmpWithBase = trackTmpDirs('tmp-dir-helper-with-base-', { base: customBase });

afterAll(() => {
  rmSync(customBase, { recursive: true, force: true });
});

let dirFromPreviousTest = '';

describe('trackTmpDirs', () => {
  it('make() creates a real directory named from the composed prefix', () => {
    const dir = tmp.make('make');
    dirFromPreviousTest = dir;

    expect(existsSync(dir)).toBe(true);
    expect(basename(dir).startsWith('tmp-dir-helper-make-')).toBe(true);
  });

  it('the registered afterEach removed the previous test\'s directory', () => {
    expect(dirFromPreviousTest).not.toBe('');
    expect(existsSync(dirFromPreviousTest)).toBe(false);
  });

  it('cleanup() removes tracked directories immediately and is idempotent', () => {
    const dir = tmp.make('cleanup');
    expect(existsSync(dir)).toBe(true);

    tmp.cleanup();
    expect(existsSync(dir)).toBe(false);
    expect(() => tmp.cleanup()).not.toThrow();
  });

  it('tracks multiple directories independently', () => {
    const first = tmp.make('multi-a');
    const second = tmp.make('multi-b');

    expect(first).not.toBe(second);
    tmp.cleanup();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });
});

let dirFromPreviousBaseTest = '';

describe('trackTmpDirs options.base', () => {
  it('defaults to os.tmpdir() when options.base is omitted', () => {
    const dir = tmp.make('base-default');

    expect(dirname(dir)).toBe(systemTmpdir());
  });

  it('uses the precomputed base directory when options.base is provided', () => {
    const dir = tmpWithBase.make('custom');
    dirFromPreviousBaseTest = dir;

    expect(dirname(dir)).toBe(customBase);
    expect(existsSync(dir)).toBe(true);
  });

  it('the registered afterEach removed the base-scoped directory but left the base itself', () => {
    expect(dirFromPreviousBaseTest).not.toBe('');
    expect(existsSync(dirFromPreviousBaseTest)).toBe(false);
    expect(existsSync(customBase)).toBe(true);
  });
});
