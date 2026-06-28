import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanForInsecureTempfile, type Finding } from '../../scripts/check-insecure-tempfile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const redDir = resolve(here, '../fixtures/insecure-tempfile/red');
const greenDir = resolve(here, '../fixtures/insecure-tempfile/green');

const kinds = (fs: Finding[]) => new Set(fs.map((f) => f.kind));

describe('insecure-tempfile guard', () => {
  it('flags python mktemp and /tmp write-targets', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(kinds(f).has('py-mktemp')).toBe(true);
    expect(kinds(f).has('py-tmp-write')).toBe(true);
  });
  it('flags shell redirect write-targets and bare mktemp', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(kinds(f).has('sh-redirect')).toBe(true);
    expect(kinds(f).has('sh-mktemp')).toBe(true);
  });
  it('does NOT flag read-only refs, comments, mktemp -d, or templated mktemp', () => {
    const f = scanForInsecureTempfile(greenDir);
    expect(f).toEqual([]);
  });
});
