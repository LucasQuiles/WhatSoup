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
 * Exit codes: 0 = no NEW violations; 1 = new violations found; 2 = infra error
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname!, '..');
const REPORT = process.argv.includes('--report');

const SCAN_DIRS = ['src', 'scripts'];
const EXTENSIONS = ['.ts', '.mjs', '.js'];
const BASELINE_PATH = path.join(ROOT, '.claude/fitness/tmpdir-baseline.json');

/** Files to skip entirely (relative to ROOT). */
const FILE_ALLOWLIST = new Set<string>([
  'scripts/check-hardcoded-tmpdir.ts',
]);

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface BaselineEntry {
  file: string;
  line: number;
}

function loadBaseline(): Set<string> {
  const s = new Set<string>();
  if (!existsSync(BASELINE_PATH)) return s;
  try {
    const data: BaselineEntry[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    for (const e of data) s.add(`${e.file}:${e.line}`);
  } catch {
    console.error(`[check-hardcoded-tmpdir] WARNING: corrupt baseline at ${BASELINE_PATH}`);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Walk & scan
// ---------------------------------------------------------------------------

interface Violation {
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

function scan(): Violation[] {
  const baseline = loadBaseline();
  const out: Violation[] = [];

  for (const sd of SCAN_DIRS) {
    const abs = path.join(ROOT, sd);
    if (!existsSync(abs)) continue;

    for (const f of walk(abs, EXTENSIONS)) {
      const rel = path.relative(ROOT, f);
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

  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const violations = scan();
  const total = violations.length;

  if (REPORT) {
    const baseline = loadBaseline();
    console.log(`tmpdir-baseline: ${baseline.size} known violations`);
    if (total === 0) {
      console.log('No NEW hardcoded /tmp/ paths found.');
      process.exit(0);
    }
    console.log(`\n${total} NEW hardcoded /tmp/ path(s) found:\n`);
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}`);
      console.log(`    ${v.snippet}`);
      console.log();
    }
    process.exit(1);
  }

  // check mode
  if (total === 0) {
    console.log('guard:hardcoded-tmpdir — passed (0 new violations).');
    process.exit(0);
  }

  console.error(`guard:hardcoded-tmpdir — FAIL — ${total} new hardcoded /tmp/ path(s).`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
  }
  console.error('\n  Use os.tmpdir() instead of hardcoded /tmp/. Add to tmpdir-baseline.json if intentional.');
  process.exit(1);
} catch (err) {
  console.error(`guard:hardcoded-tmpdir — infra error — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
