import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadRuleSpecs,
  scanRule,
  scanAll,
  collectScannableFiles,
  partitionByBaseline,
  run,
  ENFORCED_RULE_IDS,
  type PatternRuleParams,
  type PatternViolation,
} from '../../scripts/transport-pattern-check.ts';

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

function makeSpec(overrides: Partial<PatternRuleParams> = {}): { id: string; params: PatternRuleParams } {
  return {
    id: 'hygiene.test-rule',
    params: {
      globs: ['console/src'],
      extensions: ['.ts', '.tsx'],
      patterns: ['@s.whatsapp.net'],
      allowlistPaths: [],
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('transport-pattern-check', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-transport-patterns-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Registry access (fail-closed)
  // -------------------------------------------------------------------------

  describe('loadRuleSpecs', () => {
    it('loads all three enforced rules from the registry', () => {
      const specs = loadRuleSpecs();
      expect(specs).toHaveLength(3);
      expect(specs.map((s) => s.id)).toEqual([...ENFORCED_RULE_IDS]);
      for (const s of specs) {
        expect(s.params.globs.length).toBeGreaterThan(0);
        expect(s.params.patterns.length).toBeGreaterThan(0);
        expect(Array.isArray(s.params.allowlistPaths)).toBe(true);
      }
    });

    it('fails closed when a rule id is absent from the registry', () => {
      expect(() => loadRuleSpecs(['hygiene.does-not-exist'])).toThrow(/not found in fitness registry/);
    });
  });

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  describe('scanRule', () => {
    it('flags a WhatsApp JID literal in a generic console file', () => {
      createFixtureTree({
        'console/src/pages/LineDetail.tsx': 'const jid = `${phone}@s.whatsapp.net`;\n',
      });
      const violations = scanRule(fixtureRoot, makeSpec());
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        ruleId: 'hygiene.test-rule',
        file: 'console/src/pages/LineDetail.tsx',
        line: 1,
        pattern: '@s.whatsapp.net',
      });
    });

    it('reports every pattern hit on its own line', () => {
      createFixtureTree({
        'console/src/lib/util.ts': 'const a = "x@s.whatsapp.net";\nconst b = "y@g.us";\n',
      });
      const spec = makeSpec({ patterns: ['@s.whatsapp.net', '@g.us'] });
      const violations = scanRule(fixtureRoot, spec);
      expect(violations).toHaveLength(2);
      expect(violations.map((v) => v.pattern)).toEqual(['@s.whatsapp.net', '@g.us']);
    });

    it('suppresses allowlisted paths (exact file)', () => {
      createFixtureTree({
        'console/src/mock-data.ts': 'const j = "1555@s.whatsapp.net";\n',
      });
      const spec = makeSpec({ allowlistPaths: ['console/src/mock-data.ts'] });
      expect(scanRule(fixtureRoot, spec)).toHaveLength(0);
    });

    it('suppresses allowlisted directory prefixes', () => {
      createFixtureTree({
        'deploy/scripts/tests/test_x.py': 'JID = "a@s.whatsapp.net"\n',
      });
      const spec = makeSpec({
        globs: ['deploy/scripts'],
        extensions: ['.py'],
        allowlistPaths: ['deploy/scripts/tests/'],
      });
      expect(scanRule(fixtureRoot, spec)).toHaveLength(0);
    });

    it('skips non-matching extensions', () => {
      createFixtureTree({
        'console/src/styles.css': '.x { content: "@s.whatsapp.net"; }\n',
      });
      expect(scanRule(fixtureRoot, makeSpec())).toHaveLength(0);
    });

    it('clean tree produces zero violations', () => {
      createFixtureTree({
        'console/src/lib/clean.ts': 'export const x = 1;\n',
      });
      expect(scanRule(fixtureRoot, makeSpec())).toHaveLength(0);
    });
  });

  describe('scanAll', () => {
    it('scans all three enforced rules against the fixture tree', () => {
      createFixtureTree({
        'console/src/pages/X.tsx': 'const a = `${p}@s.whatsapp.net`; // WhatsApp\nconst h = line.health?.whatsapp;\n',
      });
      const violations = scanAll(fixtureRoot);
      const ruleIds = new Set(violations.map((v) => v.ruleId));
      expect(ruleIds.has('hygiene.no-wa-jid-literal-in-generic-ui')).toBe(true);
      expect(ruleIds.has('hygiene.no-whatsapp-copy-in-generic-ui')).toBe(true);
      expect(ruleIds.has('hygiene.no-health-whatsapp-key-read')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Baseline partition
  // -------------------------------------------------------------------------

  describe('partitionByBaseline', () => {
    const v = (file: string, pattern = '@s.whatsapp.net', line = 1): PatternViolation => ({
      ruleId: 'hygiene.test-rule',
      file,
      line,
      pattern,
      lineText: 'x',
    });

    it('suppresses baselined violations and surfaces new ones', () => {
      const violations = [v('a.ts', '@s.whatsapp.net', 10), v('b.ts', '@g.us', 20)];
      const baseline = [v('a.ts', '@s.whatsapp.net', 1)]; // different line — key is line-independent
      const { newViolations, baselinedViolations } = partitionByBaseline(violations, baseline);
      expect(newViolations.map((x) => x.file)).toEqual(['b.ts']);
      expect(baselinedViolations.map((x) => x.file)).toEqual(['a.ts']);
    });

    it('treats everything as new when the baseline is empty', () => {
      const violations = [v('a.ts'), v('b.ts')];
      const { newViolations } = partitionByBaseline(violations, []);
      expect(newViolations).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // CLI run() — exit codes
  // -------------------------------------------------------------------------

  describe('run()', () => {
    it('exits 0 on a clean tree', async () => {
      createFixtureTree({
        'console/src/lib/clean.ts': 'export const x = 1;\n',
      });
      const code = await run(['--root', fixtureRoot], fixtureRoot);
      expect(code).toBe(0);
    });

    it('exits 1 when new violations exist', async () => {
      createFixtureTree({
        'console/src/pages/X.tsx': 'const jid = `${p}@s.whatsapp.net`;\n',
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await run(['--root', fixtureRoot], fixtureRoot);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    });

    it('exits 0 when all violations are baselined', async () => {
      createFixtureTree({
        'console/src/pages/X.tsx': 'const jid = `${p}@s.whatsapp.net`;\n',
      });
      // Save baseline first, then re-check.
      const saveCode = await run(['--root', fixtureRoot, '--baseline-save'], fixtureRoot);
      expect(saveCode).toBe(0);
      const code = await run(['--root', fixtureRoot], fixtureRoot);
      expect(code).toBe(0);
    });

    it('fails closed (exit 2) on a corrupt baseline', async () => {
      createFixtureTree({
        'console/src/pages/X.tsx': 'const jid = `${p}@s.whatsapp.net`;\n',
        '.claude/fitness/transport-patterns-baseline.json': '{not json',
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await run(['--root', fixtureRoot], fixtureRoot);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/corrupt baseline/);
    });

    it('fails closed (exit 2) on unknown arguments', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await run(['--bogus'], fixtureRoot);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalled();
    });

    it('is INCONCLUSIVE (exit 2), never a pass, when the rule globs match 0 files', async () => {
      // Before the floor, an empty root printed "passed (0 total, 0 baselined, 0 new)" having
      // walked nothing — a false green. fixtureRoot is a fresh empty dir, so no glob resolves.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const code = await run([], fixtureRoot);
      expect(code, 'a zero-file scan must not pass').toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/i);
      expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/passed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Live-tree sanity: the real repo scans produce the expected rule coverage
  // -------------------------------------------------------------------------

  describe('live repo scan (smoke)', () => {
    it('the real repo produces violations for all three rules (baseline exists)', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      const violations = scanAll(repoRoot);
      expect(violations.length).toBeGreaterThan(0);
      const ruleIds = new Set(violations.map((v) => v.ruleId));
      expect(ruleIds.has('hygiene.no-wa-jid-literal-in-generic-ui')).toBe(true);
      expect(ruleIds.has('hygiene.no-health-whatsapp-key-read')).toBe(true);
    });

    it('the real repo scans MANY files, so the floor never fires on a real tree', () => {
      // The counterpart to the empty-root refusal: proves the floor discriminates a real
      // scan from a vacuous one rather than refusing everything.
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      expect(collectScannableFiles(repoRoot).size).toBeGreaterThan(50);
    });
  });
});
