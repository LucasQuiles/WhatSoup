import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBaseline, scan, run, type BaselineEntry } from '../../scripts/check-hardcoded-tmpdir.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureRoot: string;

function createFixtureTree(files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(fixtureRoot, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function writeBaseline(entries: BaselineEntry[]): void {
  createFixtureTree({
    '.claude/fitness/tmpdir-baseline.json': JSON.stringify(entries),
  });
}

describe('check-hardcoded-tmpdir', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-tmpdir-guard-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // loadBaseline
  // -------------------------------------------------------------------------

  describe('loadBaseline', () => {
    it('returns an empty set when the baseline file is absent', () => {
      expect(loadBaseline(fixtureRoot).size).toBe(0);
    });

    it('loads file:line keys from a valid baseline', () => {
      writeBaseline([{ file: 'src/a.ts', line: 3 }, { file: 'src/b.ts', line: 7 }]);
      const baseline = loadBaseline(fixtureRoot);
      expect(baseline.has('src/a.ts:3')).toBe(true);
      expect(baseline.has('src/b.ts:7')).toBe(true);
      expect(baseline.size).toBe(2);
    });

    it('warns and returns an empty set on a corrupt baseline', () => {
      createFixtureTree({ '.claude/fitness/tmpdir-baseline.json': '{ not json' });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const baseline = loadBaseline(fixtureRoot);
      expect(baseline.size).toBe(0);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/corrupt baseline/);
    });
  });

  // -------------------------------------------------------------------------
  // scan
  // -------------------------------------------------------------------------

  describe('scan', () => {
    it('flags a new single-quoted hardcoded /tmp/ literal', () => {
      createFixtureTree({
        'src/lib/x.ts': "const p = '/tmp/whatsoup.sock';\n",
      });
      const violations = scan(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: 'src/lib/x.ts', line: 1 });
    });

    it('flags a new double-quoted hardcoded /tmp/ literal', () => {
      createFixtureTree({
        'scripts/y.ts': 'const p = "/tmp/whatsoup.lock";\n',
      });
      const violations = scan(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: 'scripts/y.ts', line: 1 });
    });

    it('suppresses violations present in the baseline (grandfathered debt)', () => {
      createFixtureTree({
        'src/lib/legacy.ts': "const p = '/tmp/legacy.sock';\n",
      });
      writeBaseline([{ file: 'src/lib/legacy.ts', line: 1 }]);
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('reports a baselined line as new once it moves to a different line', () => {
      createFixtureTree({
        'src/lib/moved.ts': "// comment\nconst p = '/tmp/moved.sock';\n",
      });
      writeBaseline([{ file: 'src/lib/moved.ts', line: 1 }]);
      const violations = scan(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: 'src/lib/moved.ts', line: 2 });
    });

    it('skips non-scanned extensions', () => {
      createFixtureTree({
        'src/style.css': ".x { content: '/tmp/x'; }\n",
        // A real scanned file alongside it, so this test isolates
        // extension-filtering from the zero-files non-vacuity floor below.
        'src/lib/other.ts': 'export const y = 2;\n',
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('skips directories outside SCAN_DIRS', () => {
      createFixtureTree({
        'deploy/z.ts': "const p = '/tmp/outside.sock';\n",
        // A real scanned file alongside it, same isolation as above.
        'src/lib/other.ts': 'export const y = 2;\n',
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('skips its own file via the allowlist', () => {
      createFixtureTree({
        'scripts/check-hardcoded-tmpdir.ts': "const SQ = /'\\/tmp\\//g;\n",
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('clean tree produces zero violations', () => {
      createFixtureTree({ 'src/lib/clean.ts': 'export const x = 1;\n' });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Non-vacuity floor
    // -----------------------------------------------------------------------

    it('throws when src/scripts do not exist (zero files scanned, not a silent pass)', () => {
      expect(() => scan(fixtureRoot)).toThrow(/scanned zero files/);
    });

    it('throws when src/scripts exist but are empty (zero files scanned)', () => {
      mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      expect(() => scan(fixtureRoot)).toThrow(/scanned zero files/);
    });

    it('does not throw once at least one scannable file exists', () => {
      createFixtureTree({ 'src/lib/clean.ts': 'export const x = 1;\n' });
      expect(() => scan(fixtureRoot)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // run() — CLI exit codes
  // -------------------------------------------------------------------------

  describe('run()', () => {
    it('exits 0 on a clean tree', () => {
      createFixtureTree({ 'src/lib/clean.ts': 'export const x = 1;\n' });
      const code = run([], fixtureRoot);
      expect(code).toBe(0);
    });

    it('exits 1 when a new hardcoded /tmp/ path exists', () => {
      createFixtureTree({ 'src/lib/x.ts': "const p = '/tmp/x.sock';\n" });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    });

    it('exits 0 when the only violation is baselined', () => {
      createFixtureTree({ 'src/lib/legacy.ts': "const p = '/tmp/legacy.sock';\n" });
      writeBaseline([{ file: 'src/lib/legacy.ts', line: 1 }]);
      const code = run([], fixtureRoot);
      expect(code).toBe(0);
    });

    it('--report lists violations and exits 1', () => {
      createFixtureTree({ 'src/lib/x.ts': "const p = '/tmp/x.sock';\n" });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const code = run(['--report'], fixtureRoot);
      expect(code).toBe(1);
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/NEW hardcoded \/tmp\/ path/);
    });

    it('--report exits 0 with a clean-tree message when there are no violations', () => {
      createFixtureTree({ 'src/lib/clean.ts': 'export const x = 1;\n' });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const code = run(['--report'], fixtureRoot);
      expect(code).toBe(0);
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/No NEW hardcoded/);
    });

    it('exits 2 INCONCLUSIVE when a root does not exist (zero files scanned, non-vacuity floor)', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], path.join(fixtureRoot, 'does-not-exist'));
      expect(code).toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/scanned zero files/);
    });

    it('exits 2 INCONCLUSIVE when src/scripts exist but are empty (non-vacuity floor)', () => {
      mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/);
    });

    it('exits 2 INCONCLUSIVE when a SCAN_DIRS entry is not a directory', () => {
      // readdirSync throws ENOTDIR on a file where a directory is expected —
      // a distinct path into run()'s catch block from the zero-files floor.
      writeFileSync(path.join(fixtureRoot, 'src'), 'not a directory\n', 'utf8');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/);
    });
  });

  // -------------------------------------------------------------------------
  // Live-tree sanity: the real repo's grandfathered baseline stays clean
  // -------------------------------------------------------------------------

  describe('live repo scan (smoke)', () => {
    it('the real repo scans thousands of files, so the floor never fires on a real tree', () => {
      // The counterpart to the empty-tree floor tests above: proves the
      // floor discriminates a real scan from a vacuous one rather than
      // refusing everything. A throw here would itself fail the assertion.
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(() => scan(repoRoot)).not.toThrow();
    });

    it('the real repo produces zero NEW violations against its own baseline', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(scan(repoRoot)).toEqual([]);
    });

    it('the real repo baseline is non-empty (grandfathered debt is actually tracked)', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(loadBaseline(repoRoot).size).toBeGreaterThan(0);
    });
  });
});
