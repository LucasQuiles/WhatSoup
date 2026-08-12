import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BASELINE_SCHEMA_VERSION,
  CANONICAL_KEYS,
  OFFENDER_THRESHOLD,
  importsHelper,
  loadBaseline,
  loadBaselineEntries,
  matchedKeys,
  oldRegexHits,
  run,
  scan,
  type BaselineEntry,
  type Violation,
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
 * `key: vi.fn(`), literal-scoped (importing the shared helper does NOT
 * excuse inline literals — QC-2 closed that blind spot), with a
 * status/reason schemaVersion-2 growth/shrink baseline — mirroring
 * tests/scripts/console-ring-boundary-guard.test.ts's discipline.
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

function writeBaseline(entries: Array<Partial<BaselineEntry> & { file: string }>): void {
  createFixtureTree({
    '.claude/fitness/loggermock-baseline.json': JSON.stringify({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      entries: entries.map((e) => ({ status: 'debt', reason: 'fixture', ...e })),
    }),
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

    it('is reentrant — repeated calls on the same source return identical results (no shared lastIndex)', () => {
      const src = `const l = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };`;
      const first = matchedKeys(src);
      const second = matchedKeys(src);
      expect(second).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
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

    it('flags a helper-importing file that still spells out >=4 local keys (literal-scoped, not import-gated)', () => {
      createFixtureTree({
        'tests/foo.test.ts': `
          const { loggerMock } = await import('../helpers/logger-mock.ts');
          const override = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
        `,
      });
      const violations = scan(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: 'tests/foo.test.ts', importsHelper: true } satisfies Partial<Violation>);
    });

    it('does not flag a helper-importing file with fewer than 4 inline keys', () => {
      createFixtureTree({
        'tests/foo.test.ts': `
          const { loggerMock } = await import('../helpers/logger-mock.ts');
          const partial = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

  describe('loadBaselineEntries / loadBaseline', () => {
    it('returns an empty array when the baseline file is absent', () => {
      expect(loadBaselineEntries(fixtureRoot)).toEqual([]);
      expect(loadBaseline(fixtureRoot)).toEqual([]);
    });

    it('loads schemaVersion-2 entries with status and reason intact', () => {
      writeBaseline([
        { file: 'tests/b.test.ts', status: 'permanent', reason: 'real SUT' },
        { file: 'tests/a.test.ts', status: 'debt', reason: 'to migrate' },
      ]);
      const entries = loadBaselineEntries(fixtureRoot);
      expect(entries).toEqual([
        { file: 'tests/b.test.ts', status: 'permanent', reason: 'real SUT' },
        { file: 'tests/a.test.ts', status: 'debt', reason: 'to migrate' },
      ]);
    });

    it('loadBaseline is the sorted file-name view over the same entries', () => {
      writeBaseline([{ file: 'tests/b.test.ts' }, { file: 'tests/a.test.ts' }]);
      expect(loadBaseline(fixtureRoot)).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    });

    it('warns and returns null (corrupt, not empty) on malformed JSON', () => {
      createFixtureTree({ '.claude/fitness/loggermock-baseline.json': '{ not json' });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadBaselineEntries(fixtureRoot)).toBeNull();
      expect(loadBaseline(fixtureRoot)).toEqual([]);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/corrupt baseline/);
    });

    it('treats the legacy schemaVersion-less array format as corrupt (null)', () => {
      createFixtureTree({
        '.claude/fitness/loggermock-baseline.json': JSON.stringify([{ file: 'tests/a.test.ts', keysMatched: 4 }]),
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadBaselineEntries(fixtureRoot)).toBeNull();
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/corrupt baseline/);
    });

    it('treats an entry missing status/reason as corrupt (null)', () => {
      createFixtureTree({
        '.claude/fitness/loggermock-baseline.json': JSON.stringify({
          schemaVersion: BASELINE_SCHEMA_VERSION,
          entries: [{ file: 'tests/a.test.ts' }],
        }),
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadBaselineEntries(fixtureRoot)).toBeNull();
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

    it('exits 2 INCONCLUSIVE when the baseline exists but is corrupt (never a silent pass)', () => {
      createFixtureTree({
        'tests/clean.test.ts': `export const x = 1;`,
        '.claude/fitness/loggermock-baseline.json': '{ not json',
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = run([], fixtureRoot);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE.*corrupt/s);
    });
  });

  // -------------------------------------------------------------------------
  // Live-repo ratchet (the actual gate)
  // -------------------------------------------------------------------------

  describe('live repo ratchet', () => {
    // One scan + one baseline load shared by every assertion below — the
    // repo walk reads ~1300 files, so re-running it per test was pure
    // wall-clock waste (~294ms per push).
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    let violations: Violation[];
    let entries: BaselineEntry[];

    beforeAll(() => {
      violations = scan(repoRoot);
      entries = loadBaselineEntries(repoRoot) ?? [];
    });

    it('the real repo scan finds offenders (the floor never fires on a real tree)', () => {
      expect(violations.length).toBeGreaterThan(0);
    });

    it('the live baseline parses as schemaVersion-2 with status and reason on every entry', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fresh = loadBaselineEntries(repoRoot);
      expect(errSpy.mock.calls.flat().join(' ')).not.toMatch(/corrupt baseline/);
      expect(fresh).not.toBeNull();
      expect(fresh!.length).toBeGreaterThan(0);
    });

    it('pins current logger-mock offenders to the baseline exactly (growth fails naming the offender)', () => {
      const baseline = new Set(entries.map((e) => e.file));
      const growth = violations.filter((v) => !baseline.has(v.file));
      expect(
        growth.map((v) => v.file),
        `new logger-mock offender(s) outside the sanctioned baseline — replace the inline literal with tests/helpers/logger-mock.ts APIs, or if intentional, add a status/reason entry to .claude/fitness/loggermock-baseline.json deliberately:\n${growth.map((v) => v.file).join('\n')}`,
      ).toEqual([]);
    });

    it('baseline entries that no longer match require a deliberate shrink (baseline edit)', () => {
      const actualFiles = new Set(violations.map((v) => v.file));
      const shrink = entries.map((e) => e.file).filter((f) => !actualFiles.has(f));
      expect(
        shrink,
        `baseline entr(y/ies) no longer match — remove from .claude/fitness/loggermock-baseline.json in the same change (this is progress, not a bug):\n${shrink.join('\n')}`,
      ).toEqual([]);
    });

    it('baseline files still exist (the ratchet cannot silently pin a moved/deleted file)', () => {
      for (const { file } of entries) {
        expect(existsSync(path.join(repoRoot, file)), `${file} moved or was deleted — update the ratchet baseline`).toBe(true);
      }
    });
  });
});
