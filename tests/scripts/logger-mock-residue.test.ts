import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_KEYS,
  ISSUE_2243_OLD_REGEXES,
  OFFENDER_THRESHOLD,
  importsHelper,
  loadBaseline,
  matchedKeys,
  oldRegexHits,
  run,
  scan,
} from '../../scripts/check-logger-mock-residue.ts';

/**
 * Enforcement for #2243 (no-op logger test fixture DRY debt).
 *
 * #2243's own "Enforcement mechanism" section proposed a ratchet test
 * (`tests/scripts/logger-mock-ssot.test.ts`) that was never committed — it
 * also imports `tinyglobby`, which is not in package.json, so it could
 * never have run even if it had been. The umbrella-residue audit
 * (2026-08-02, WhatSoup merge-gate project state,
 * staging/umbrella-residue-audit.md) found the issue's own proposed regex,
 * run against the real codebase, hits exactly 1 of ~160 genuine local
 * logger mocks — most are declared inside `vi.mock()` factories, with keys
 * in a different order, or bound to a name other than `logger`. This file
 * is the real ratchet: order-independent (>=4 of 7 canonical keys as
 * `key: vi.fn(`), helper-import-aware, with a growth/shrink baseline —
 * mirroring tests/scripts/console-ring-boundary-guard.test.ts's discipline.
 */

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

function writeBaseline(entries: Array<{ file: string; keysMatched?: number }>): void {
  createFixtureTree({
    '.claude/fitness/loggermock-baseline.json': JSON.stringify(entries),
  });
}

describe('check-logger-mock-residue', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-loggermock-guard-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // matchedKeys — order-independent, name-anchored
  // -------------------------------------------------------------------------

  describe('matchedKeys', () => {
    it('finds all 7 canonical keys in the classic contiguous byte-identical shape', () => {
      const src = `
        const logger = {
          trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
          fatal: vi.fn(), child: vi.fn(() => logger),
        };
      `;
      expect(matchedKeys(src).sort()).toEqual([...CANONICAL_KEYS].sort());
    });

    it('finds keys regardless of order (the exact gap in the old ratchet)', () => {
      const src = `
        const mockAppLogger = {
          error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
        };
      `;
      expect(matchedKeys(src).sort()).toEqual(['debug', 'error', 'info', 'warn']);
    });

    it('does not count a prefixed identifier as the bare key (onError/mockError vs error)', () => {
      const src = `
        const handlers = {
          onError: vi.fn(), mockError: vi.fn(), getChild: vi.fn(),
        };
      `;
      expect(matchedKeys(src)).toEqual([]);
    });

    it('matches quoted keys too', () => {
      const src = `const l = { 'trace': vi.fn(), "debug": vi.fn() };`;
      expect(matchedKeys(src).sort()).toEqual(['debug', 'trace']);
    });

    it('does not match keys bound to something other than vi.fn(', () => {
      const src = `const l = { trace: noop, debug: () => {}, info: realLoggerFn };`;
      expect(matchedKeys(src)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // importsHelper
  // -------------------------------------------------------------------------

  describe('importsHelper', () => {
    it('detects the dynamic-import form used by all current consumers', () => {
      expect(importsHelper(`const { loggerMock } = await import('../helpers/logger-mock.ts');`)).toBe(true);
    });

    it('detects a static import form', () => {
      expect(importsHelper(`import { loggerMock } from '../../helpers/logger-mock';`)).toBe(true);
    });

    it('is false for source with no reference to the helper', () => {
      expect(importsHelper(`const logger = { trace: vi.fn() };`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // oldRegexHits — proves the #2243-proposed ratchet's blind spot
  // -------------------------------------------------------------------------

  describe('oldRegexHits (the #2243-proposed ratchet, preserved verbatim)', () => {
    it('DOES hit the classic contiguous trace/debug/info shape', () => {
      const src = `
        const logger = {
          trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        };
      `;
      expect(oldRegexHits(src)).toBe(true);
    });

    it('RED: misses a real-shaped local mock with keys out of order and a non-"logger" name', () => {
      // Same fixture family the audit spot-checked as a genuine local
      // inline mock (tests/core/heal.test.ts, tests/main-bootstrap.test.ts):
      // >=4 canonical keys, but NOT the contiguous trace->debug->info run,
      // and NOT bound to a bare `const logger = {`.
      const src = `
        const mockHealLogger = {
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
        };
      `;
      // The new order-independent signal catches it...
      expect(matchedKeys(src).length).toBeGreaterThanOrEqual(OFFENDER_THRESHOLD);
      // ...but #2243's own proposed ratchet regex does not.
      expect(oldRegexHits(src)).toBe(false);
    });

    it('the two ISSUE_2243_OLD_REGEXES are exactly the pair the issue body proposed', () => {
      expect(ISSUE_2243_OLD_REGEXES).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // scan — fixture-tree integration
  // -------------------------------------------------------------------------

  describe('scan', () => {
    it('flags a new local mock with >=4 keys as an offender', () => {
      createFixtureTree({
        'tests/foo.test.ts': `
          const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
        `,
      });
      const violations = scan(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: 'tests/foo.test.ts' });
    });

    it('does not flag a file with fewer than 4 keys', () => {
      createFixtureTree({
        'tests/foo.test.ts': `const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };`,
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('excludes a file that imports the shared helper, even if it also has >=4 local keys', () => {
      createFixtureTree({
        'tests/foo.test.ts': `
          const { loggerMock } = await import('../helpers/logger-mock.ts');
          const override = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
        `,
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('only scans tests/**/*.test.ts(x), not helper or source files', () => {
      createFixtureTree({
        'tests/helpers/logger-mock.ts': `
          export function loggerMock() {
            return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
          }
        `,
        'src/logger.ts': `export const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`,
        // A real scanned file alongside, so this test isolates
        // extension/dir-filtering from the non-vacuity floor.
        'tests/real.test.ts': `export const x = 1;`,
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('excludes tests/browser/** and tests/browser-motion/** (out of scope for the default vitest run)', () => {
      createFixtureTree({
        'tests/browser/foo.test.tsx': `const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`,
        'tests/browser-motion/bar.test.tsx': `const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`,
        // a real scanned file alongside, so this isolates dir-exclusion from the non-vacuity floor
        'tests/real.test.ts': `export const x = 1;`,
      });
      expect(scan(fixtureRoot)).toHaveLength(0);
    });

    it('throws (non-vacuity floor) when tests/ is missing', () => {
      expect(() => scan(fixtureRoot)).toThrow(/tests\/ not found/);
    });

    it('throws (non-vacuity floor) when tests/ exists but has zero test files', () => {
      createFixtureTree({ 'tests/README.md': 'not a test file' });
      expect(() => scan(fixtureRoot)).toThrow(/scanned zero test files/);
    });
  });

  // -------------------------------------------------------------------------
  // loadBaseline
  // -------------------------------------------------------------------------

  describe('loadBaseline', () => {
    it('returns an empty array when the baseline file is absent', () => {
      expect(loadBaseline(fixtureRoot)).toEqual([]);
    });

    it('loads and sorts file names from a valid baseline', () => {
      writeBaseline([{ file: 'tests/b.test.ts' }, { file: 'tests/a.test.ts' }]);
      expect(loadBaseline(fixtureRoot)).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    });

    it('warns and returns an empty array on a corrupt baseline', () => {
      createFixtureTree({ '.claude/fitness/loggermock-baseline.json': '{ not json' });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadBaseline(fixtureRoot)).toEqual([]);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/corrupt baseline/);
    });
  });

  // -------------------------------------------------------------------------
  // run() — CLI ratchet semantics (growth fails naming the offender, shrink
  // fails demanding a baseline edit)
  // -------------------------------------------------------------------------

  describe('run', () => {
    it('exits 0 when the scan matches the baseline exactly', () => {
      createFixtureTree({
        'tests/foo.test.ts': `const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`,
      });
      writeBaseline([{ file: 'tests/foo.test.ts' }]);
      expect(run([], fixtureRoot)).toBe(0);
    });

    it('exits 1 and names the file for a NEW offender outside the baseline (growth)', () => {
      createFixtureTree({
        'tests/foo.test.ts': `const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`,
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(1);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/NEW: tests\/foo\.test\.ts/);
    });

    it('exits 1 when a baseline entry no longer matches (shrink requires a deliberate baseline edit)', () => {
      createFixtureTree({
        'tests/foo.test.ts': `const { loggerMock } = await import('../helpers/logger-mock.ts');`,
      });
      writeBaseline([{ file: 'tests/foo.test.ts' }]);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(1);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/STALE BASELINE ENTRY: tests\/foo\.test\.ts/);
    });

    it('--report lists new offenders and exits 1', () => {
      createFixtureTree({
        'tests/foo.test.ts': `const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`,
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const code = run(['--report'], fixtureRoot);
      expect(code).toBe(1);
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/NEW offender/);
    });

    it('exits 2 INCONCLUSIVE when tests/ is missing (non-vacuity floor)', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/);
    });
  });

  // -------------------------------------------------------------------------
  // Live-repo ratchet (the actual gate)
  // -------------------------------------------------------------------------

  describe('live repo ratchet', () => {
    it('the real repo scans thousands of files, so the floor never fires on a real tree', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(() => scan(repoRoot)).not.toThrow();
    });

    it('pins current logger-mock offenders to the baseline exactly (growth fails naming the offender)', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      const baseline = new Set(loadBaseline(repoRoot));
      const actual = scan(repoRoot);

      const growth = actual.filter((v) => !baseline.has(v.file));
      expect(
        growth.map((v) => v.file),
        `new logger-mock offender(s) outside the sanctioned baseline — migrate to tests/helpers/logger-mock.ts, or if intentional, add to .claude/fitness/loggermock-baseline.json deliberately:\n${growth.map((v) => v.file).join('\n')}`,
      ).toEqual([]);
    });

    it('baseline entries that no longer match require a deliberate shrink (baseline edit)', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      const baseline = loadBaseline(repoRoot);
      const actualFiles = new Set(scan(repoRoot).map((v) => v.file));

      const shrink = baseline.filter((f) => !actualFiles.has(f));
      expect(
        shrink,
        `baseline entr(y/ies) no longer match — remove from .claude/fitness/loggermock-baseline.json in the same change (this is progress, not a bug):\n${shrink.join('\n')}`,
      ).toEqual([]);
    });

    it('baseline files still exist (the ratchet cannot silently pin a moved/deleted file)', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      for (const file of loadBaseline(repoRoot)) {
        expect(existsSync(path.join(repoRoot, file)), `${file} moved or was deleted — update the ratchet baseline`).toBe(true);
      }
    });

    it('the baseline is non-empty (grandfathered debt is actually tracked, not silently dropped)', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(loadBaseline(repoRoot).length).toBeGreaterThan(100);
    });

    it('the real "lid-resolver-reconcile-dedup" file (the one #2243-proposed regex DOES catch) is in the baseline', () => {
      // Converse check: the new signal is a strict superset of the old
      // regex on real content, not just on the synthetic RED fixture above.
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(loadBaseline(repoRoot)).toContain('tests/core/lid-resolver-reconcile-dedup.test.ts');
    });
  });
});
