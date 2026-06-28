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
  it('FIX-A: flags f-string /tmp write-target open(f"/tmp/...", "w") as py-tmp-write', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'py-tmp-write' && x.snippet.includes('open(f"'))).toBe(true);
  });
  it('FIX-A: flags f-string pathlib Path(f"/tmp/...").write_text() as py-tmp-write', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'py-tmp-write' && x.snippet.includes('write_text') && x.snippet.includes('f"/tmp/'))).toBe(true);
  });
  it('does NOT flag read-only refs, comments, mktemp -d, templated mktemp, or safe X-run template (FP-1)', () => {
    const f = scanForInsecureTempfile(greenDir);
    expect(f).toEqual([]);
  });
  it('FIX-B: does NOT flag mktemp --directory (GNU long form)', () => {
    const f = scanForInsecureTempfile(greenDir);
    const mkdirFindings = f.filter((x) => x.kind === 'sh-mktemp');
    expect(mkdirFindings).toEqual([]);
  });
  it('excludes guard fixture corpus on full-tree scan (gate-green reachable)', () => {
    // Scanning from the repo root must NOT include the guard's own intentional-
    // violation fixtures — those would make the blocking gate permanently un-greenable.
    const repoRoot = resolve(here, '../..');
    const findings = scanForInsecureTempfile(repoRoot);
    const fixturePrefix = 'tests/fixtures/insecure-tempfile/';
    const fixtureFindings = findings.filter((f) => f.file.startsWith(fixturePrefix));
    expect(fixtureFindings).toEqual([]);
  });

  // Extensionless shebang coverage (closes silent-skip of 7 real scripts)
  it('SHB-1: flags extensionless python shebang file with tempfile.mktemp as py-mktemp', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'py-mktemp' && x.file.endsWith('shebang_py_tool'))).toBe(true);
  });
  it('SHB-2: flags extensionless bash shebang file with /tmp redirect as sh-redirect', () => {
    const f = scanForInsecureTempfile(redDir);
    expect(f.some((x) => x.kind === 'sh-redirect' && x.file.endsWith('shebang_sh_tool'))).toBe(true);
  });
  it('SHB-3: does NOT flag extensionless python shebang file using mkstemp (safe)', () => {
    const f = scanForInsecureTempfile(greenDir);
    const fromSafe = f.filter((x) => x.file.endsWith('shebang_py_safe'));
    expect(fromSafe).toEqual([]);
  });
  it('SHB-4: does NOT flag extensionless file with no shebang even if body has insecure patterns', () => {
    const f = scanForInsecureTempfile(greenDir);
    const fromData = f.filter((x) => x.file.endsWith('no_shebang_data'));
    expect(fromData).toEqual([]);
  });

  it('FAIL-CLOSED: throws on an unreadable/nonexistent root rather than returning a clean result', () => {
    // Security contract: an IO fault must NOT be swallowed into an empty (clean-looking)
    // finding list — that would false-pass the block gate. The scan must propagate the
    // error so the CLI's catch in main() fails closed (exit 2). Runtime-verified: a
    // nonexistent root yields `FATAL ENOENT … exit 2`; this locks that propagation in.
    expect(() => scanForInsecureTempfile(resolve(here, '../fixtures/__definitely_not_a_real_dir__'))).toThrow();
  });
});
