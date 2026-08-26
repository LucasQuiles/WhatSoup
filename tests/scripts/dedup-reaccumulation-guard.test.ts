/**
 * Dedup re-accumulation guard
 *
 * Prevents new local definitions of the folded idiom family from accumulating
 * outside their SSOT homes.  The folded idioms are:
 *
 *   - `isRecord`    — SSOT: src/lib/type-guards.ts, console/src/lib/type-guards.ts
 *   - `record`      — SSOT: folded into asRecord in src/lib/type-guards.ts (#793)
 *   - `recordValue` — SSOT: same as above (#793)
 *   - `safeEqual`   — SSOT: src/lib/safe-compare.ts (exported as safeStringEqual)
 *
 * SSOT homes are unconditionally exempt.  All other files that carry a
 * definition today are tracked in the KNOWN_CLONES allowlist below.
 *
 * Detection is AST-based (TypeScript compiler API), not regex: the previous
 * revision collected only `.ts` files and matched only
 * `function <name>(` declarations, so a clone declared in a `.tsx` file or as
 * an arrow (`const isRecord = (...) => ...`) was invisible — the guard
 * reported the allowlist clean while three console `.tsx` clones existed.
 * The AST walk sees function declarations, arrow functions, and function
 * expressions bound to a banned name, anywhere in the file (including inside
 * components), and cannot be fooled by comments or string literals.
 *
 * Precedent: tests/runtimes/agent/providers/no-duplicates.test.ts
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Identifiers whose local (re)definition is banned outside SSOT homes. */
const BANNED_NAMES = new Set(['isRecord', 'record', 'recordValue', 'safeEqual']);

/**
 * Cheap content prefilter: only files that mention a banned name at all are
 * AST-parsed. Without this, two full-tree TypeScript parses (one per scan
 * consumer) exceeded the 10s default test timeout on contended CI runners
 * (quality 24.x lane). Precision is unaffected: the prefilter only ever
 * ADMITS files, and the AST decides.
 */
const BANNED_NAME_RE = /\b(?:isRecord|record|recordValue|safeEqual)\b/;

/**
 * Files that are unconditionally exempt — they are the SSOTs.
 *
 * Paths are repo-relative, normalised with forward slashes.
 */
const SSOT_HOMES = new Set([
  'src/lib/type-guards.ts',
  'src/lib/safe-compare.ts',
  'console/src/lib/type-guards.ts',
  // Fleet keeps this compatibility export for existing local imports.
  'src/fleet/safe-compare.ts',
  // parser-utils exports its own isRecord wrapper that delegates to the SSOT
  // predicate; the no-duplicates test already enforces the delegation contract.
  'src/runtimes/agent/providers/parser-utils.ts',
]);

/**
 * Grandfathered allowlist — files that carry a clone today but are tracked.
 *
 * Format: `"<repo-relative-path>:<name>"`.
 *
 * The three console `.tsx` entries below are the clones the pre-AST guard
 * could not see.  They are scheduled to be folded into
 * console/src/lib/type-guards.ts (burn-down batch A04); remove each entry in
 * the fold commit — the stale-entry test below enforces the removal.
 */
const KNOWN_CLONES = new Set<string>([
  // TODO(batch A04): fold into console/src/lib/type-guards.ts and remove.
  'console/src/components/AddLineWizard.tsx:isRecord',
  'console/src/components/wizard/ModelAuthStep.tsx:isRecord',
  'console/src/components/agents/panels.tsx:isRecord',
  // False friend, not a clone: a void outcome-recorder (`record(outcome) =>
  // push + write result file`), unrelated to the record-coercion idiom this
  // guard exists for.  Kept visible here rather than special-cased in the
  // scanner so a real coercion clone under the same name still needs a
  // deliberate entry.
  'src/runtimes/agent/capability-obligation-drain-now-service.ts:record',
]);

/** Directories to scan (relative to repo root). */
const SCAN_DIRS = ['src', 'scripts', 'console/src'];

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

/** Recursively collect .ts and .tsx files (not .d.ts) from a directory. */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (
      entry.isFile()
      && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      && !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Names from BANNED_NAMES that this file locally DECLARES as a function:
 * `function <name>(...)`, `const/let/var <name> = (...) => ...`, or
 * `const <name> = function (...)`, at any nesting depth.
 */
function bannedDeclarations(relPath: string, content: string): string[] {
  const kind = relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relPath, content, ts.ScriptTarget.ES2022, false, kind);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && BANNED_NAMES.has(node.name.text)) {
      found.push(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && BANNED_NAMES.has(node.name.text)
      && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

let scanMemo: { violations: string[]; allMatches: Set<string> } | null = null;

function scanForViolations(): { violations: string[]; allMatches: Set<string> } {
  if (scanMemo !== null) return scanMemo;
  const violations: string[] = [];
  const allMatches = new Set<string>();

  for (const dir of SCAN_DIRS) {
    const absDir = resolve(REPO_ROOT, dir);
    const files = collectSourceFiles(absDir);

    for (const file of files) {
      const relPath = repoRelative(file);
      if (SSOT_HOMES.has(relPath)) continue;

      const content = readFileSync(file, 'utf8');
      if (!BANNED_NAME_RE.test(content)) continue;
      for (const name of bannedDeclarations(relPath, content)) {
        const key = `${relPath}:${name}`;
        allMatches.add(key);

        if (!KNOWN_CLONES.has(key)) {
          violations.push(
            `${relPath} — locally declares \`${name}\`. Import from the SSOT instead of defining locally.`,
          );
        }
      }
    }
  }

  scanMemo = { violations, allMatches };
  return scanMemo;
}

describe('Dedup re-accumulation guard', () => {
  it('no new local definitions of folded idioms outside SSOT homes', () => {
    const { violations } = scanForViolations();

    expect(
      violations,
      `New clone(s) detected:\n${violations.map((v) => `  • ${v}`).join('\n')}\n\n` +
      `SSOT homes: src/lib/type-guards.ts, src/lib/safe-compare.ts`,
    ).toEqual([]);
    // Repository-fitness scan over the full tree — CI runners under full-suite
    // contention exceeded the default 10s.
  }, 30_000);

  it('allowlist contains only entries that actually match (no stale entries)', () => {
    const { allMatches } = scanForViolations();

    const stale = [...KNOWN_CLONES].filter((entry) => !allMatches.has(entry));
    expect(
      stale,
      `Stale allowlist entries — file was cleaned but entry was not removed from KNOWN_CLONES: ` +
      stale.join(', '),
    ).toEqual([]);
    // Shares the memoized scan with the violation test; budget kept for a cold run.
  }, 30_000);

  it('detects .tsx and arrow-declaration clones (self-test of the scanner)', () => {
    // The pre-AST guard failed exactly these two shapes; pin them so a future
    // "simplification" back to regex/.ts-only goes red immediately.
    const tsxArrow = bannedDeclarations(
      'fixture.tsx',
      'export const Widget = () => null;\nconst isRecord = (v: unknown) => typeof v === "object";\n',
    );
    expect(tsxArrow).toEqual(['isRecord']);

    const nestedFn = bannedDeclarations(
      'fixture.tsx',
      'function Component() {\n  function safeEqual(a: string, b: string) { return a === b; }\n  return null;\n}\n',
    );
    expect(nestedFn).toEqual(['safeEqual']);

    // Comments and strings must NOT match (the regex version could).
    const decoy = bannedDeclarations(
      'fixture.ts',
      '// function isRecord(\nconst s = "function record(";\n',
    );
    expect(decoy).toEqual([]);
  });

  it('SSOT homes are reachable and export the canonical functions', () => {
    // This is a fitness test over repository source: asserting on the SSOT
    // files' export signatures IS the behavior under test, not a proxy for it.
    const typeGuards = readFileSync(resolve(REPO_ROOT, 'src/lib/type-guards.ts'), 'utf8');
    expect(typeGuards).toMatch(/export function isRecord\(/); // test-integrity: source-string-ok

    const safeCompare = readFileSync(resolve(REPO_ROOT, 'src/lib/safe-compare.ts'), 'utf8');
    expect(safeCompare).toMatch(/export function safeStringEqual\(/);

    const fleetSafeCompare = readFileSync(resolve(REPO_ROOT, 'src/fleet/safe-compare.ts'), 'utf8');
    expect(fleetSafeCompare).toContain("from '../lib/safe-compare.ts'");

    const consoleTG = readFileSync(resolve(REPO_ROOT, 'console/src/lib/type-guards.ts'), 'utf8');
    expect(consoleTG).toMatch(/export function isRecord\(/); // test-integrity: source-string-ok
  });
});
