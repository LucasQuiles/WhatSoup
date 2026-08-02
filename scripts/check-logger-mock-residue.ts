#!/usr/bin/env -S node --experimental-strip-types
/**
 * guard:logger-mock-residue — detect test files that re-implement the no-op
 * `logger` fixture locally instead of importing the shared
 * `tests/helpers/logger-mock.ts` helper (#2243).
 *
 * #2243 shipped with a proposed "arch ratchet" embedded as prose in the
 * issue body (`tests/scripts/logger-mock-ssot.test.ts`, never committed —
 * it also imports `tinyglobby`, which is not a repo dependency, so it could
 * never have run). That proposed detector requires either:
 *   - a contiguous `trace: vi.fn()...debug: vi.fn()...info: vi.fn()` run in
 *     that exact key order, or
 *   - a top-level `const logger = {...trace: vi.fn()`
 * Spot-checking the real codebase (2026-08-02 umbrella-residue audit) found
 * this hits exactly 1 of ~160 real local logger mocks — most are declared
 * inside `vi.mock()` factories, with keys in a different order, or bound to
 * a name other than `logger` (e.g. `mockHealLogger`). ISSUE_2243_OLD_REGEXES
 * below preserves those two patterns verbatim so the gap is provable, not
 * just asserted (see tests/scripts/logger-mock-residue.test.ts).
 *
 * This scanner replaces that non-functional detector with an
 * order-independent, name-independent signal: a test file is an offender if
 * it spells out >=4 of the 7 canonical logger keys as `key: vi.fn(` and does
 * NOT import the shared helper. The threshold and signal shape come from
 * the same audit (staging/loggermock-residue-final.log under the WhatSoup
 * merge-gate project state).
 *
 * Baseline lives at .claude/fitness/loggermock-baseline.json (ratchet
 * discipline shared with tmpdir/boundary baselines): growth (a NEW offender
 * outside the baseline) fails naming the file; shrink (a baseline entry that
 * stopped matching, e.g. because a lane migrated it to the shared helper)
 * also fails, until the baseline is edited — mirroring
 * tests/scripts/console-ring-boundary-guard.test.ts's growth/shrink pair.
 *
 * Usage:
 *   node scripts/check-logger-mock-residue.ts          # check — exit 0/1/2
 *   node scripts/check-logger-mock-residue.ts --report  # verbose listing
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname!, '..');

const TESTS_DIR = 'tests';
// These subtrees are excluded from the default vitest run (vitest.config.ts
// `test.exclude`) — they collect only under the separate browser configs —
// so they are out of scope for a guard whose enforcement path is the
// default `npm test` / `coverage:check` run.
const EXCLUDE_DIRS = new Set(['browser', 'browser-motion']);
const BASELINE_REL_PATH = '.claude/fitness/loggermock-baseline.json';

export const CANONICAL_KEYS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child'] as const;
export const OFFENDER_THRESHOLD = 4;

/**
 * The two literal patterns #2243 proposed as its own arch ratchet, kept
 * verbatim (not paraphrased) so the "misses real offenders" claim is
 * reproducible against the exact text the issue shipped.
 */
export const ISSUE_2243_OLD_REGEXES: RegExp[] = [
  /trace:\s*vi\.fn\(\).*debug:\s*vi\.fn\(\).*info:\s*vi\.fn\(\)/s,
  /const\s+logger\s*=\s*\{[^}]*trace:\s*vi\.fn\(\)/s,
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Builds an anchored `key: vi.fn(` matcher for one canonical key. Anchored
 * on the left so `onError: vi.fn()` / `mockError: vi.fn()` cannot be
 * mistaken for the `error` key — a bare substring match would count both.
 */
function keyPattern(key: string): RegExp {
  return new RegExp(`(?:^|[{,\\s])['"]?${key}['"]?\\s*:\\s*vi\\.fn\\(`, 'm');
}

const KEY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = CANONICAL_KEYS.map(
  (key) => [key, keyPattern(key)] as const,
);

/** Canonical logger keys spelled out as `key: vi.fn(` in this source, order-independent. */
export function matchedKeys(source: string): string[] {
  return KEY_PATTERNS.filter(([, re]) => re.test(source)).map(([key]) => key);
}

/** True if the source imports the shared no-op logger helper (any specifier form). */
export function importsHelper(source: string): boolean {
  return /\b(?:from\s*|import\(|require\()\s*['"][^'"]*logger-mock(?:\.ts)?['"]/.test(source);
}

/** True if either of #2243's own proposed ratchet regexes matches this source. */
export function oldRegexHits(source: string): boolean {
  return ISSUE_2243_OLD_REGEXES.some((re) => re.test(source));
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function loadBaseline(root: string): string[] {
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  if (!existsSync(baselinePath)) return [];
  try {
    const data: Array<{ file: string }> = JSON.parse(readFileSync(baselinePath, 'utf8'));
    return data.map((e) => e.file).sort();
  } catch {
    console.error(`[check-logger-mock-residue] WARNING: corrupt baseline at ${baselinePath}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Walk & scan
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  keysMatched: string[];
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name) && path.basename(dir) === TESTS_DIR) continue;
      walk(path.join(dir, e.name), acc);
      continue;
    }
    if (e.isFile() && (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx'))) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/**
 * All current test files that spell out >=4 canonical logger keys as
 * `key: vi.fn(` and do not import the shared helper. Baseline-blind by
 * design (mirrors tests/scripts/console-ring-boundary-guard.test.ts's
 * consoleToSrcEdges()) — ratchet growth/shrink comparison happens at the
 * call site (CLI `run()` below, or the ratchet test).
 */
export function scan(root: string): Violation[] {
  const testsRoot = path.join(root, TESTS_DIR);
  if (!existsSync(testsRoot)) {
    throw new Error(`tests/ not found at ${testsRoot} — result is inconclusive, refusing to certify`);
  }

  const files = walk(testsRoot);

  // Non-vacuity floor: a real scan of this repo's tests/ always finds
  // thousands of files. Zero means the walk found nothing to examine
  // (missing/misconfigured TESTS_DIR, or a genuinely empty tree), and "0
  // violations" would be indistinguishable from a legitimate clean scan if
  // allowed through as a pass. Same pattern as
  // scripts/check-hardcoded-tmpdir.ts's filesScanned===0 throw.
  if (files.length === 0) {
    throw new Error(`scanned zero test files under ${testsRoot} — result is inconclusive, refusing to certify`);
  }

  const out: Violation[] = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const source = readFileSync(f, 'utf8');
    if (importsHelper(source)) continue;
    const keys = matchedKeys(source);
    if (keys.length >= OFFENDER_THRESHOLD) {
      out.push({ file: rel, keysMatched: keys });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run(argv: string[] = process.argv.slice(2), root: string = ROOT): number {
  const report = argv.includes('--report');

  try {
    const violations = scan(root);
    const baseline = new Set(loadBaseline(root));
    const actual = new Set(violations.map((v) => v.file));

    const growth = violations.filter((v) => !baseline.has(v.file));
    const shrink = [...baseline].filter((f) => !actual.has(f)).sort();

    if (report) {
      console.log(`logger-mock-baseline: ${baseline.size} known offenders`);
      console.log(`current scan: ${violations.length} offender(s), ${growth.length} new, ${shrink.length} shrunk`);
      if (growth.length > 0) {
        console.log(`\nNEW offender(s) (not in baseline):\n`);
        for (const v of growth) console.log(`  ${v.file}  (keys: ${v.keysMatched.join(', ')})`);
      }
      if (shrink.length > 0) {
        console.log(`\nBaseline entries no longer matching (update the baseline):\n`);
        for (const f of shrink) console.log(`  ${f}`);
      }
      if (growth.length === 0 && shrink.length === 0) console.log('\nBaseline matches current scan exactly.');
      return growth.length === 0 && shrink.length === 0 ? 0 : 1;
    }

    if (growth.length === 0 && shrink.length === 0) {
      console.log('guard:logger-mock-residue — passed (baseline matches current scan).');
      return 0;
    }

    console.error(`guard:logger-mock-residue — FAIL — ${growth.length} new offender(s), ${shrink.length} stale baseline entr(y/ies).`);
    for (const v of growth) console.error(`  NEW: ${v.file}`);
    for (const f of shrink) console.error(`  STALE BASELINE ENTRY: ${f}`);
    console.error('\n  New offenders: import tests/helpers/logger-mock.ts instead of a local mock, or update the baseline deliberately.');
    console.error('  Stale entries: the file no longer matches (e.g. migrated) — remove it from the baseline in the same change.');
    return 1;
  } catch (err) {
    console.error(`guard:logger-mock-residue — INCONCLUSIVE — ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
