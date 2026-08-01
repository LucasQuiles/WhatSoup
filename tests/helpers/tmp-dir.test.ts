import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { trackTmpDirs } from './tmp-dir.ts';

const tmp = trackTmpDirs('tmp-dir-helper-');

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
