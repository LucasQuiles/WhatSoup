#!/usr/bin/env -S node --experimental-strip-types
/**
 * guard:hardcoded-tmpdir — detect new hardcoded /tmp/ paths in source.
 *
 * Hardcoded `/tmp/` paths are Linux-only and break on macOS (which uses
 * `/var/folders/...`) and NixOS (where `/tmp` may not exist or be unwritable).
 *
 * Uses a baseline at .claude/fitness/tmpdir-baseline.json to grandfather known
 * violations. Only NEW violations (not in baseline) cause failure, so existing
 * debt does not block CI. New violations indicate code that should use
 * os.tmpdir() instead.
 *
 * Usage:
 *   node scripts/check-hardcoded-tmpdir.ts          # check — exit 0/1 (default)
 *   node scripts/check-hardcoded-tmpdir.ts --report  # verbose listing
 *
 * Exit codes: 0 = no NEW violations; 1 = new violations found; 2 = INCONCLUSIVE
 * (infra error, or the non-vacuity floor below)
 *
 * Scan root is always the real repo (import.meta-rooted, resolved once as
 * ROOT below) — cwd cannot redirect it. `scan`/`loadBaseline` take an
 * explicit root so tests can point them at a synthetic fixture tree without
 * touching the real repo.
 *
 * NON-VACUITY FLOOR: scan() throws if it walks src/ + scripts/ and finds
 * ZERO scannable files. Without this, a broken/misconfigured SCAN_DIRS (or a
 * genuinely empty tree) would silently report "0 violations — passed", a
 * false green indistinguishable from a real clean scan. Same pattern as
 * generate-catch-ratchet.mjs's `results.length === 0` throw and
 * durability-writer-guard.ts's `discoveredTableCount === 0` INCONCLUSIVE path
 * — both cited as skip-immune's floor precedent in SCOPE_MAP.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname!, '..');

const SCAN_DIRS = ['src', 'scripts'];
const EXTENSIONS = ['.ts', '.mjs', '.js'];
const BASELINE_REL_PATH = '.claude/fitness/tmpdir-baseline.json';

/** Files to skip entirely (relative to the scan root). */
const FILE_ALLOWLIST = new Set<string>([
  'scripts/check-hardcoded-tmpdir.ts',
]);

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export interface BaselineEntry {
  file: string;
  line: number;
}

export function loadBaseline(root: string): Set<string> {
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  const s = new Set<string>();
  if (!existsSync(baselinePath)) return s;
  try {
    const data: BaselineEntry[] = JSON.parse(readFileSync(baselinePath, 'utf8'));
    for (const e of data) s.add(`${e.file}:${e.line}`);
  } catch {
    console.error(`[check-hardcoded-tmpdir] WARNING: corrupt baseline at ${baselinePath}`);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Walk & scan
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

// Single-quoted: '/tmp/...'
const SQ = /'\/tmp\//g;
// Double-quoted: "/tmp/..."
const DQ = /"\/tmp\//g;

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(f);
  }
  return acc;
}

export function scan(root: string): Violation[] {
  const baseline = loadBaseline(root);
  const out: Violation[] = [];
  let filesScanned = 0;

  for (const sd of SCAN_DIRS) {
    const abs = path.join(root, sd);
    if (!existsSync(abs)) continue;

    const files = walk(abs, EXTENSIONS);
    filesScanned += files.length;

    for (const f of files) {
      const rel = path.relative(root, f);
      if (FILE_ALLOWLIST.has(rel)) continue;

      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!;

        SQ.lastIndex = 0;
        DQ.lastIndex = 0;

        const isViolation = SQ.test(text) || DQ.test(text);
        if (isViolation) {
          const key = `${rel}:${i + 1}`;
          if (!baseline.has(key)) {
            out.push({ file: rel, line: i + 1, snippet: text.trim().slice(0, 140) });
          }
        }
      }
    }
  }

  // Non-vacuity floor — see file header. A real scan of this repo's src/ +
  // scripts/ always finds thousands of files; zero means the walk found
  // nothing to examine (missing/misconfigured SCAN_DIRS, or a genuinely
  // empty tree), and "0 violations" would be indistinguishable from a
  // legitimate clean scan if allowed through as a pass.
  if (filesScanned === 0) {
    throw new Error(
      `scanned zero files under ${SCAN_DIRS.map((d) => `${d}/`).join(', ')} at ${root} — result is inconclusive, refusing to certify`,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run(argv: string[] = process.argv.slice(2), root: string = ROOT): number {
  const report = argv.includes('--report');

  try {
    const violations = scan(root);
    const total = violations.length;

    if (report) {
      const baseline = loadBaseline(root);
      console.log(`tmpdir-baseline: ${baseline.size} known violations`);
      if (total === 0) {
        console.log('No NEW hardcoded /tmp/ paths found.');
        return 0;
      }
      console.log(`\n${total} NEW hardcoded /tmp/ path(s) found:\n`);
      for (const v of violations) {
        console.log(`  ${v.file}:${v.line}`);
        console.log(`    ${v.snippet}`);
        console.log();
      }
      return 1;
    }

    // check mode
    if (total === 0) {
      console.log('guard:hardcoded-tmpdir — passed (0 new violations).');
      return 0;
    }

    console.error(`guard:hardcoded-tmpdir — FAIL — ${total} new hardcoded /tmp/ path(s).`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    }
    console.error('\n  Use os.tmpdir() instead of hardcoded /tmp/. Add to tmpdir-baseline.json if intentional.');
    return 1;
  } catch (err) {
    console.error(`guard:hardcoded-tmpdir — INCONCLUSIVE — ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
