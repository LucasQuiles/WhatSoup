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
  it('FN-3: flags direct "from tempfile import mktemp" as py-mktemp', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'py-mktemp' && x.snippet.includes('from tempfile import'))).toBe(true);
  });
  it('FN-2: flags open() with keyword mode= argument as py-tmp-write', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'py-tmp-write' && x.snippet.includes('mode='))).toBe(true);
  });
  it('FN-1: flags pathlib Path.open() with write mode as py-tmp-write', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'py-tmp-write' && x.snippet.includes('.open('))).toBe(true);
  });
  it('FN-4: flags tee with flags before /tmp target as sh-redirect', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'sh-redirect' && /\btee\s+-/.test(x.snippet))).toBe(true);
  });
  it('does NOT flag read-only refs, comments, mktemp -d, templated mktemp, or safe X-run template (FP-1)', () => {
    const f = scanForInsecureTempfile(greenDir);
    expect(f).toEqual([]);
  });
});
