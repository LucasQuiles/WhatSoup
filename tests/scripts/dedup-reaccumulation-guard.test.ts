/**
 * Dedup re-accumulation guard
 *
 * Prevents new local definitions of the folded idiom family from accumulating
 * outside their SSOT homes.  The folded idioms are:
 *
 *   - `function isRecord(` — SSOT: src/lib/type-guards.ts, console/src/lib/type-guards.ts
 *   - `function record(`   — SSOT: folded into asRecord in src/lib/type-guards.ts (#793)
 *   - `function recordValue(` — SSOT: same as above (#793)
 *   - `function safeEqual(` — SSOT: src/fleet/safe-compare.ts (exported as safeStringEqual)
 *
 * SSOT homes are unconditionally exempt.  All other files that carry a
 * definition today are tracked in the KNOWN_CLONES allowlist below.
 *
 * Dependency: this branch (refactor/dedup-reaccumulation-guard) must land
 * AFTER refactor/asrecord-guard-core-ssot (#793), which folds the src/
 * clones.  Once #793 lands the allowlist entries for src/ and scripts/
 * can be removed — the test will enforce the now-clean state automatically.
 *
 * The two scripts/ clones (check-instance-config.ts and
 * source-runtime-drift-check.ts) are folded IN THIS BRANCH.  Those entries
 * were removed from the allowlist once the fold commits landed (red→green).
 *
 * Precedent: tests/runtimes/agent/providers/no-duplicates.test.ts
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Regex patterns that are banned outside SSOT homes. */
const BANNED_PATTERNS = [
  /\bfunction isRecord\(/,      // index 0
  /\bfunction record\(/,        // index 1
  /\bfunction recordValue\(/,   // index 2
  /\bfunction safeEqual\(/,     // index 3
] as const;

/**
 * Files that are unconditionally exempt — they are the SSOTs.
 *
 * Paths are repo-relative, normalised with forward slashes.
 */
const SSOT_HOMES = new Set([
  'src/lib/type-guards.ts',
  'src/fleet/safe-compare.ts',
  'console/src/lib/type-guards.ts',
  // parser-utils exports its own isRecord wrapper that delegates to the SSOT
  // predicate; the no-duplicates test already enforces the delegation contract.
  'src/runtimes/agent/providers/parser-utils.ts',
]);

/**
 * Grandfathered allowlist — files that carry a clone today but are tracked.
 *
 * Format: `"<repo-relative-path>:<pattern-index>"` where pattern-index is the
 * 0-based index into BANNED_PATTERNS above.
 *
 * Lifecycle:
 *   - src/ entries and scripts/harness-maintenance-guard.ts: folded by
 *     #793 (refactor/asrecord-guard-core-ssot), which merged into
 *     origin/main before this branch landed.  All those entries removed.
 *   - scripts/check-instance-config.ts + scripts/source-runtime-drift-check.ts:
 *     folded IN THIS BRANCH.  Entries removed in the fold commit.
 *
 * Allowlist is now empty — the codebase is clean.
 */
const KNOWN_CLONES = new Set<string>([
  // All pre-existing clones have been folded.
  // Add an entry here (with a TODO comment) when a temporary exception is needed.
]);

/** Directories to scan (relative to repo root). */
const SCAN_DIRS = ['src', 'scripts', 'console/src'];

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

/** Recursively collect .ts files (not .d.ts) from a directory. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function scanForViolations(): { violations: string[]; allMatches: Set<string> } {
  const violations: string[] = [];
  const allMatches = new Set<string>();

  for (const dir of SCAN_DIRS) {
    const absDir = resolve(REPO_ROOT, dir);
    const files = collectTsFiles(absDir);

    for (const file of files) {
      const relPath = repoRelative(file);
      if (SSOT_HOMES.has(relPath)) continue;

      const content = readFileSync(file, 'utf8');

      BANNED_PATTERNS.forEach((regex, index) => {
        if (!regex.test(content)) return;

        const key = `${relPath}:${index}`;
        allMatches.add(key);

        if (!KNOWN_CLONES.has(key)) {
          violations.push(
            `${relPath} — matches banned pattern #${index} (${regex.source}). ` +
            `Import from SSOT instead of defining locally.`,
          );
        }
      });
    }
  }

  return { violations, allMatches };
}

describe('Dedup re-accumulation guard', () => {
  it('no new local definitions of folded idioms outside SSOT homes', () => {
    const { violations } = scanForViolations();

    expect(
      violations,
      `New clone(s) detected:\n${violations.map((v) => `  • ${v}`).join('\n')}\n\n` +
      `SSOT homes: src/lib/type-guards.ts, src/fleet/safe-compare.ts`,
    ).toEqual([]);
  });

  it('allowlist contains only entries that actually match (no stale entries)', () => {
    const { allMatches } = scanForViolations();

    const stale = [...KNOWN_CLONES].filter((entry) => !allMatches.has(entry));
    expect(
      stale,
      `Stale allowlist entries — file was cleaned but entry was not removed from KNOWN_CLONES: ` +
      stale.join(', '),
    ).toEqual([]);
  });

  it('SSOT homes are reachable and export the canonical functions', () => {
    // This is a fitness test over repository source: asserting on the SSOT
    // files' export signatures IS the behavior under test, not a proxy for it.
    const typeGuards = readFileSync(resolve(REPO_ROOT, 'src/lib/type-guards.ts'), 'utf8');
    expect(typeGuards).toMatch(/export function isRecord\(/); // test-integrity: source-string-ok

    const safeCompare = readFileSync(resolve(REPO_ROOT, 'src/fleet/safe-compare.ts'), 'utf8');
    expect(safeCompare).toMatch(/export function safeStringEqual\(/);

    const consoleTG = readFileSync(resolve(REPO_ROOT, 'console/src/lib/type-guards.ts'), 'utf8');
    expect(consoleTG).toMatch(/export function isRecord\(/); // test-integrity: source-string-ok
  });
});
