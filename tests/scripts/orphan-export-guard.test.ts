/**
 * Orphaned-export dead-code guard.
 *
 * Enforces invariant (A): no `export function`/`export const`/`export class`
 * declaration in `src/` may have ZERO references anywhere in the repository
 * source corpus (`src/` + `tests/`). Such a symbol is dead code — an
 * orphan-after-refactor.
 *
 * Motivating incident: PR #1507 refactored a fallback path and left
 * `fallbackRecoveryRequiresModelUsability` exported with zero remaining
 * references (an orphan). This guard would have flagged it.
 *
 * Companion invariant (B) — the local-clone-of-SSOT ban (motivated by PR
 * #1514's local `isRecord` clone) is enforced by the SEPARATE, pre-existing
 * `tests/scripts/dedup-reaccumulation-guard.test.ts`. This file does not
 * duplicate that coverage; it complements it with the orphan-export class.
 *
 * CONSERVATISM (deliberate, to keep this WARN-tier guard false-positive-free):
 *   - A "reference" is ANY word-boundary occurrence of the identifier in ANY
 *     other location in the corpus — including comments, strings, JSDoc, and
 *     barrel re-exports (`export { name } from '...'`). This intentionally
 *     over-counts references so the guard only fires on HIGH-CONFIDENCE
 *     orphans (a symbol whose name appears literally nowhere else). It will
 *     NOT catch a symbol that is only re-exported by a barrel but never
 *     consumed, nor one referenced solely via a computed/string key — those
 *     are accepted false-negatives, the safe direction for a guard.
 *   - Genuine zero-reference PUBLIC-API exports (entrypoints consumed only by
 *     out-of-corpus code) belong in PUBLIC_API_ALLOWLIST below.
 *
 * Convention: mirrors tests/scripts/dedup-reaccumulation-guard.test.ts
 * (filesystem-scanning vitest fitness test; discovered by the default
 * vitest-run include glob "tests/**\/*.test.ts"; no package.json script).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Directories whose `.ts` files form the reference corpus. */
const CORPUS_DIRS = ['src', 'tests'];

/** Directory scanned for exported declarations. */
const SCAN_DIR = 'src';

/**
 * Matches a top-level exported value/type declaration and captures its name.
 * Covers `export function`, `export async function`, `export const`,
 * `export class`. Does NOT cover `export { ... }` re-exports (those are not
 * new declarations) nor `export default` (anonymous), by design.
 */
const EXPORT_DECL_RE =
  /^\s*export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

/**
 * Explicit allowlist of genuinely public-API exports that legitimately have
 * zero in-corpus references (consumed only by out-of-corpus callers, e.g.
 * published entrypoints or dynamically wired plugins).
 *
 * Format: `"<repo-relative-path>:<exportName>"`, forward-slash normalised.
 *
 * Empty today — current main has zero orphan exports. Add an entry (with a
 * justifying comment) only for a proven public-API export, never to silence a
 * real orphan.
 */
const PUBLIC_API_ALLOWLIST = new Set<string>([
  // e.g. "src/index.ts:createBot", // published package entrypoint
  // JID-family predicate consumed by the stacked transport-surfaces branch
  // (src/core/jid-constants.ts:164 isPnJid/isLidJid/isSignalJid/isImessageJid
  // chain + tests/core/jid-constants.test.ts there). Zero references on THIS
  // branch by design — it lands one layer before its consumer.
  'src/core/jid-constants.ts:isImessageJid',
  // #3560 operator CLI default: consumed only by scripts/inbound-ownership-snapshot.ts
  // (out of corpus). It lives beside the snapshot reader it configures.
  'src/runtimes/agent/inbound-ownership-snapshot.ts:DEFAULT_OWNERSHIP_MIN_AGE_MINUTES',
]);

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

/** Recursively collect non-declaration `.ts` files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

/** Count word-boundary occurrences of `name` in `text`. */
function countOccurrences(name: string, text: string): number {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

const WORD_RUN_RE = /\w+/g;
const WORD_ONLY_RE = /^\w+$/;

/**
 * Count every maximal `\w+` run in the corpus once. For a name made only of
 * `\w` characters, the `\bname\b` matches are exactly the maximal runs equal to
 * the name, so a lookup gives the same total as `countOccurrences` summed over
 * the corpus. Re-scanning the ~30 MB corpus with a fresh regex for each of
 * ~2,300 exports took ~50 s per test on CI.
 */
function buildWordRunIndex(corpus: Map<string, string>): Map<string, number> {
  const index = new Map<string, number>();
  for (const text of corpus.values()) {
    for (const word of text.match(WORD_RUN_RE) ?? []) {
      index.set(word, (index.get(word) ?? 0) + 1);
    }
  }
  return index;
}

function countCorpusOccurrences(
  name: string,
  corpus: Map<string, string>,
  wordRuns: Map<string, number>,
): number {
  if (WORD_ONLY_RE.test(name)) return wordRuns.get(name) ?? 0;
  // Names containing `$` keep the original per-file regex semantics.
  let total = 0;
  for (const text of corpus.values()) {
    total += countOccurrences(name, text);
  }
  return total;
}

interface ScanResult {
  orphans: string[];
  allExportKeys: Set<string>;
}

// Both tests read the same scan; computing it lazily lets `-t` run either alone.
let cachedScan: ScanResult | undefined;

function getScan(): ScanResult {
  cachedScan ??= scanForOrphans();
  return cachedScan;
}

function scanForOrphans(): ScanResult {
  // Build the corpus once.
  const corpus = new Map<string, string>();
  for (const dir of CORPUS_DIRS) {
    const absDir = resolve(REPO_ROOT, dir);
    for (const file of collectTsFiles(absDir)) {
      corpus.set(repoRelative(file), readFileSync(file, 'utf8'));
    }
  }

  const wordRuns = buildWordRunIndex(corpus);

  const scanAbs = resolve(REPO_ROOT, SCAN_DIR);
  const scanFiles = collectTsFiles(scanAbs).filter((f) => !f.endsWith('.test.ts'));

  const orphans: string[] = [];
  const allExportKeys = new Set<string>();

  for (const file of scanFiles) {
    const relPath = repoRelative(file);
    const content = corpus.get(relPath) ?? readFileSync(file, 'utf8');

    // Collect all exported declaration names in this file (with multiplicity,
    // so a name declared N times has its N declaration occurrences subtracted).
    EXPORT_DECL_RE.lastIndex = 0;
    const declaredNames: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = EXPORT_DECL_RE.exec(content))) {
      declaredNames.push(match[1]);
    }

    for (const name of new Set(declaredNames)) {
      const key = `${relPath}:${name}`;
      allExportKeys.add(key);

      // Total occurrences across the entire corpus.
      const total = countCorpusOccurrences(name, corpus, wordRuns);

      // Subtract the declaration occurrences in THIS file (one per `export …`
      // declaration line). Anything left is a genuine reference.
      const declCount = declaredNames.filter((d) => d === name).length;
      const references = total - declCount;

      if (references <= 0 && !PUBLIC_API_ALLOWLIST.has(key)) {
        orphans.push(
          `${relPath} — export \`${name}\` has ZERO references in src/ or tests/. ` +
            `Remove it (orphan-after-refactor), or if it is a genuine public-API ` +
            `entrypoint add it to PUBLIC_API_ALLOWLIST.`,
        );
      }
    }
  }

  return { orphans, allExportKeys };
}

describe('Orphaned-export dead-code guard', () => {
  it('no exported function/const/class in src/ is unreferenced everywhere (#1507 class)', () => {
    const { orphans } = getScan();

    expect(
      orphans,
      `Orphaned export(s) detected:\n${orphans.map((o) => `  • ${o}`).join('\n')}`,
    ).toEqual([]);
  }, 60_000);

  it('public-API allowlist contains only entries that still exist (no stale entries)', () => {
    const { allExportKeys } = getScan();

    const stale = [...PUBLIC_API_ALLOWLIST].filter((entry) => !allExportKeys.has(entry));
    expect(
      stale,
      `Stale PUBLIC_API_ALLOWLIST entries — export was removed but allowlist ` +
        `entry was not: ${stale.join(', ')}`,
    ).toEqual([]);
  }, 60_000);
});
