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
 * it spells out >=4 of the 7 canonical logger keys as `key: vi.fn(`. The
 * threshold and signal shape come from the same audit
 * (staging/loggermock-residue-final.log under the WhatSoup merge-gate
 * project state).
 *
 * The signal is literal-scoped, NOT import-gated: importing the shared
 * helper does not excuse inline literals in the same file. (The original
 * scanner skipped any helper-importing file wholesale, which let dozens of
 * files keep full inline mocks behind a ceremonial import — the 2026-08-11
 * quality audit found 27 of 133 helper-importers still carrying >=4 inline
 * keys.) Each violation records `importsHelper` so remediation lanes can
 * pick the right idiom per file.
 *
 * Baseline lives at .claude/fitness/loggermock-baseline.json (ratchet
 * discipline shared with tmpdir/boundary baselines), schemaVersion 2:
 * `{ schemaVersion, entries: [{ file, status, reason }] }` where status is
 * 'permanent' (the file legitimately needs inline literals, e.g. logger
 * self-tests exercising the real SUT shape) or 'debt' (to be migrated; the
 * campaign completion signal is zero 'debt' entries). Growth (a NEW
 * offender outside the baseline) fails naming the file; shrink (a baseline
 * entry that stopped matching, e.g. because a lane migrated it) also
 * fails, until the baseline is edited — mirroring
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
 * Single-pass alternation over all 7 canonical keys, anchored on the left so
 * `onError: vi.fn()` / `mockError: vi.fn()` cannot be mistaken for the
 * `error` key — a bare substring match would count both. Consumed via
 * `matchAll` (which iterates on an internal clone, never mutating this
 * regex's `lastIndex`), so `matchedKeys` stays reentrant.
 */
const KEY_ALTERNATION = new RegExp(
  `(?:^|[{,\\s])['"]?(${CANONICAL_KEYS.join('|')})['"]?\\s*:\\s*vi\\.fn\\(`,
  'gm',
);

/** Canonical logger keys spelled out as `key: vi.fn(` in this source, in canonical order. */
export function matchedKeys(source: string): string[] {
  if (!source.includes('vi.fn(')) return [];
  const found = new Set<string>();
  for (const m of source.matchAll(KEY_ALTERNATION)) found.add(m[1]);
  return CANONICAL_KEYS.filter((key) => found.has(key));
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

export const BASELINE_SCHEMA_VERSION = 2;

export interface BaselineEntry {
  file: string;
  /** 'permanent': inline literals are the point (e.g. logger self-tests). 'debt': to be migrated. */
  status: 'permanent' | 'debt';
  reason: string;
}

/**
 * Parses the schemaVersion-2 baseline. Returns [] when the file is absent
 * (a legitimate empty ratchet), and null when the file EXISTS but is
 * corrupt — missing entries, wrong schemaVersion, malformed JSON, an entry
 * without file/status/reason. Callers must treat null as inconclusive, not
 * as an empty baseline: a corrupt baseline says nothing about which
 * offenders are sanctioned.
 */
export function loadBaselineEntries(root: string): BaselineEntry[] | null {
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  if (!existsSync(baselinePath)) return [];
  try {
    const data = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      schemaVersion?: number;
      entries?: BaselineEntry[];
    };
    if (data.schemaVersion !== BASELINE_SCHEMA_VERSION || !Array.isArray(data.entries)) {
      throw new Error(`expected { schemaVersion: ${BASELINE_SCHEMA_VERSION}, entries: [...] }`);
    }
    for (const e of data.entries) {
      if (typeof e.file !== 'string' || (e.status !== 'permanent' && e.status !== 'debt') || typeof e.reason !== 'string' || e.reason.length === 0) {
        throw new Error(`malformed entry: ${JSON.stringify(e)}`);
      }
    }
    return data.entries;
  } catch (err) {
    console.error(`[check-logger-mock-residue] WARNING: corrupt baseline at ${baselinePath} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Sorted baseline file names (ratchet comparison view; corrupt reads as empty here — use loadBaselineEntries to distinguish). */
export function loadBaseline(root: string): string[] {
  return (loadBaselineEntries(root) ?? [])
    .map((e) => e.file)
    .sort();
}

// ---------------------------------------------------------------------------
// Walk & scan
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  keysMatched: string[];
  /** Whether the file also imports the shared helper — picks the remediation idiom, never excuses the literal. */
  importsHelper: boolean;
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
 * `key: vi.fn(` — importing the shared helper does NOT excuse the literal
 * (literal-scoped signal; see header). Baseline-blind by design (mirrors
 * tests/scripts/console-ring-boundary-guard.test.ts's consoleToSrcEdges())
 * — ratchet growth/shrink comparison happens at the call site (CLI `run()`
 * below, or the ratchet test).
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
    const keys = matchedKeys(source);
    if (keys.length >= OFFENDER_THRESHOLD) {
      out.push({ file: rel, keysMatched: keys, importsHelper: importsHelper(source) });
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
    const entries = loadBaselineEntries(root);
    if (entries === null) {
      // Corrupt baseline: no way to tell sanctioned offenders from growth.
      // INCONCLUSIVE, never a pass — mirrors the zero-files floor above.
      throw new Error('baseline file exists but is corrupt — fix .claude/fitness/loggermock-baseline.json before certifying');
    }
    const baseline = new Set(entries.map((e) => e.file));
    const actual = new Set(violations.map((v) => v.file));

    const growth = violations.filter((v) => !baseline.has(v.file));
    const shrink = entries
      .map((e) => e.file)
      .filter((f) => !actual.has(f))
      .sort();
    const debt = entries.filter((e) => e.status === 'debt').length;

    if (report) {
      console.log(`logger-mock-baseline: ${baseline.size} known offender(s) — ${debt} debt, ${baseline.size - debt} permanent`);
      console.log(`current scan: ${violations.length} offender(s), ${growth.length} new, ${shrink.length} shrunk`);
      if (growth.length > 0) {
        console.log(`\nNEW offender(s) (not in baseline):\n`);
        for (const v of growth) console.log(`  ${v.file}  (keys: ${v.keysMatched.join(', ')}; imports helper: ${v.importsHelper ? 'yes' : 'no'})`);
      }
      if (shrink.length > 0) {
        console.log(`\nBaseline entries no longer matching (update the baseline):\n`);
        for (const f of shrink) console.log(`  ${f}`);
      }
      if (growth.length === 0 && shrink.length === 0) console.log('\nBaseline matches current scan exactly.');
      return growth.length === 0 && shrink.length === 0 ? 0 : 1;
    }

    if (growth.length === 0 && shrink.length === 0) {
      const completion = debt === 0 ? ' Zero debt entries — #2977 remediation complete; remaining entries are permanent.' : ` ${debt} debt entr(y/ies) remain.`;
      console.log(`guard:logger-mock-residue — passed (baseline matches current scan).${completion}`);
      return 0;
    }

    console.error(`guard:logger-mock-residue — FAIL — ${growth.length} new offender(s), ${shrink.length} stale baseline entr(y/ies).`);
    for (const v of growth) console.error(`  NEW: ${v.file}${v.importsHelper ? '  (imports the helper but still spells out inline literals)' : ''}`);
    for (const f of shrink) console.error(`  STALE BASELINE ENTRY: ${f}`);
    console.error('\n  New offenders: replace the inline literal with tests/helpers/logger-mock.ts APIs (importing the helper alone does not excuse the literal), or add a status/reason baseline entry deliberately.');
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
