/**
 * arch.ring-boundaries guard-ring promotion (owner directive 2026-07-19). The
 * eslint ring has carried fitness/ring-boundaries at warn (visibility only);
 * this guard runs the SAME rule through the registry-derived fitness config
 * and count-ratchets it against .claude/fitness/baseline.json. Proves: a
 * planted lower-ring → higher-ring import FAILS the guard (red direction), a
 * shrink under a stale baseline FAILS demanding a same-commit ratchet-down,
 * a clean fixture counts zero, and the live tree sits exactly at baseline
 * (born green — at promotion time the count was 57: a ratchet, not yet a
 * pure block).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RING_RULE_ID,
  countRingViolations,
  runRingGuard,
} from '../../scripts/ring-boundary-guard.ts';
import { readBaselineCount, readTaxonomyDocCount } from '../../scripts/ssot-pattern-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface FixtureOptions {
  violation: boolean;
  baselineCount: number;
}

function makeFixture({ violation, baselineCount }: FixtureOptions): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ring-guard-fixture-'));
  mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'fleet'), { recursive: true });
  mkdirSync(path.join(dir, '.claude', 'fitness'), { recursive: true });
  mkdirSync(path.join(dir, 'docs', 'architecture'), { recursive: true });
  mkdirSync(path.join(dir, 'eslint-rules'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'fleet', 'util.ts'), 'export const u = 1;\n', 'utf8');
  writeFileSync(
    path.join(dir, 'src', 'core', 'subject.ts'),
    violation
      ? "import { u } from '../fleet/util.ts';\nexport const v = u;\n"
      : 'export const v = 1;\n',
    'utf8',
  );
  writeFileSync(
    path.join(dir, '.claude', 'fitness', 'baseline.json'),
    JSON.stringify({ rules: { [RING_RULE_ID]: { violationCount: baselineCount } } }),
    'utf8',
  );
  // The shared fitness config also enables the catch ratchet on src/. These
  // focused ring fixtures have no inherited catch debt, so make that separate
  // fail-closed dependency explicit instead of weakening its missing-file rule.
  writeFileSync(
    path.join(dir, 'eslint-rules', 'catch-ratchet-baseline.json'),
    '[]\n',
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'docs', 'architecture', 'fitness-taxonomy.md'),
    `| rule | violations (baseline) |\n|------|--|\n| \`${RING_RULE_ID}\` | ${baselineCount} |\n`,
    'utf8',
  );
  return dir;
}

describe('ring-boundary-guard — fixture (red both directions)', () => {
  it('counts a planted domain → composition import as a violation', async () => {
    const dir = makeFixture({ violation: true, baselineCount: 0 });
    try {
      const { count, findings } = await countRingViolations(dir, REPO_ROOT);
      expect(count).toBe(1);
      expect(findings[0]!.file).toBe('src/core/subject.ts');
      expect(findings[0]!.message).toContain('must not import');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a clean fixture as zero', async () => {
    const dir = makeFixture({ violation: false, baselineCount: 0 });
    try {
      const { count } = await countRingViolations(dir, REPO_ROOT);
      expect(count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a planted violation over a zero baseline FAILS the guard (above-baseline)', async () => {
    const dir = makeFixture({ violation: true, baselineCount: 0 });
    try {
      const result = await runRingGuard(dir, REPO_ROOT, dir);
      expect(result.ok).toBe(false);
      expect(result.verdict.status).toBe('above-baseline');
      expect(result.findings).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shrink under a STALE baseline FAILS demanding a same-commit ratchet-down', async () => {
    const dir = makeFixture({ violation: true, baselineCount: 2 }); // actual count is 1
    try {
      const result = await runRingGuard(dir, REPO_ROOT, dir);
      expect(result.ok).toBe(false);
      expect(result.verdict.status).toBe('ratchet-down-required');
      expect(result.verdict.message).toContain('violationCount=1');
      expect(result.verdict.message).toContain('RATCHET DOWN in this same commit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ring-boundary-guard — live tree (born green at the promoted baseline)', () => {
  it('the live tree sits exactly at the recorded baseline and passes', async () => {
    const result = await runRingGuard(REPO_ROOT);
    expect(result.verdict.status, result.verdict.message).toBe('ok');
    expect(result.twinDocMismatch).toBeNull();
    expect(result.ok).toBe(true);
    const baseline = readBaselineCount(REPO_ROOT, RING_RULE_ID);
    expect(result.verdict.count).toBe(baseline);
    // Promotion honesty: this is a RATCHET (count > 0), not yet a pure block.
    expect(baseline).toBeGreaterThan(0);
  }, 120_000);

  it('the taxonomy-doc twin matches baseline.json', () => {
    const baseline = readBaselineCount(REPO_ROOT, RING_RULE_ID);
    expect(baseline).toBeDefined();
    expect(readTaxonomyDocCount(REPO_ROOT, RING_RULE_ID)).toBe(baseline);
  });
});
