/**
 * Raw DB-cast ratchet (#2191).
 *
 * src/lib/db-query.ts centralizes the single unavoidable cast for
 * node:sqlite result rows (queryAll/queryOne/allFromStatement/
 * getFromStatement). Every OTHER `.all()`/`.get()` call that leans on a
 * raw `as unknown as` / `as any` cast is grandfathered here and may only
 * shrink. New code must use the wrappers.
 *
 * If this test fails with a HIGHER count: migrate the new call site to the
 * db-query wrappers instead of casting inline. If it fails with a LOWER
 * count: good — ratchet down by setting DB_CAST_BASELINE to the new count.
 *
 * The predicate is line-based by design (call and cast on one line); it is
 * a deterministic regression ratchet, not an exhaustive type-safety proof —
 * fitness/unsafe-type-escape covers the general `any` surface.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = join(repoRoot, 'src');

/** The one file allowed to cast: it IS the wrapper. */
const WRAPPER_FILE = join('src', 'lib', 'db-query.ts');

const DB_CAST_PATTERN = /\.(all|get)\([^)]*\)[^;]*as (unknown as|any)\b/;

const DB_CAST_BASELINE = 50;

interface CastSite {
  file: string;
  line: number;
  text: string;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function findCastSites(): CastSite[] {
  const sites: CastSite[] = [];
  for (const file of collectTsFiles(srcRoot).sort()) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    if (rel === WRAPPER_FILE.split(sep).join('/')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, idx) => {
      if (DB_CAST_PATTERN.test(text)) {
        sites.push({ file: rel, line: idx + 1, text: text.trim() });
      }
    });
  }
  return sites;
}

describe('fitness: raw db-cast ratchet (#2191)', () => {
  it(`holds the raw .all()/.get() cast count at exactly ${DB_CAST_BASELINE}`, () => {
    const sites = findCastSites();
    const listing = sites.map((s) => `  ${s.file}:${s.line}  ${s.text}`).join('\n');
    expect(
      sites.length,
      sites.length > DB_CAST_BASELINE
        ? `New raw DB cast introduced — use queryAll/queryOne/allFromStatement/getFromStatement from src/lib/db-query.ts instead.\n${listing}`
        : `Cast count dropped below the baseline — ratchet down: set DB_CAST_BASELINE to ${sites.length}.\n${listing}`,
    ).toBe(DB_CAST_BASELINE);
  });
});
