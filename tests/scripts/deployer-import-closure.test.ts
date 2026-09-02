import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEPLOY_SCRIPT_REL,
  RUNTIME_MANIFEST_REL,
  computeImportClosure,
  parseDeployPinPaths,
} from '../../scripts/lib/deployer-import-closure.ts';

// The bot-errors deployer allowlist must be CLOSED UNDER IMPORT.
//
// `deploy/scripts/whatsoup-bot-errors-deploy.sh` materializes exactly the paths
// in its `FILES=()` array into a host's bot-errors root, and `do_verify`
// iterates exactly that array. A root holding every allowlisted file and
// nothing else therefore prints `VERIFY_OK` — even when the shipped daemons
// crash on import because a module they import at module scope was never
// shipped. Reproduced on origin/main 44241cee: a root built from only the 18
// allowlisted files verified clean (18 x MATCH, SMOKE ok, VERIFY_OK, exit 0)
// while bot-errors-collector.py, bot-errors-dispatcher.py,
// bot-errors-health-check.py and bot-errors-heartbeat-watchdog.py all raised
// ModuleNotFoundError.
//
// THE EXPECTED SET IS THE IMPORT GRAPH, NOT A PIN LIST. The pre-existing
// deployer-static-parity test derived its covered set from the pin list and
// then asserted the pin list was contained in it (`FILES ⊆ FILES`), which is
// true however broken the closure is. Every expectation below is seeded from
// the allowlist and expanded by parsing real imports — the TypeScript compiler
// for `.ts`, python's own `ast` for `.py`.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

interface RuntimeManifest {
  files: Array<{ path: string; sha256: string; mustContain?: string[] }>;
}

/**
 * Count allowlist entries with a line scanner, independent of the regex-slice
 * parser under test. If that parser silently drops entries the closure it feeds
 * is under-seeded and every containment assertion below weakens, so the two
 * mechanisms must agree. This is the same shape
 * `deploy/scripts/tests/test_deployer_mutation.sh` uses.
 */
function countQuotedFilesEntries(scriptText: string): number {
  let inside = false;
  let count = 0;
  for (const rawLine of scriptText.split('\n')) {
    const line = rawLine.trim();
    if (line === 'FILES=(') {
      inside = true;
      continue;
    }
    if (inside && line === ')') break;
    if (inside && /^"[^"]+"$/.test(line)) count += 1;
  }
  return count;
}

describe('bot-errors deployer allowlist is closed under import', () => {
  const scriptText = readFileSync(path.join(repoRoot, DEPLOY_SCRIPT_REL), 'utf8');
  const pinPaths = parseDeployPinPaths(scriptText);
  const closure = computeImportClosure(repoRoot, pinPaths);
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, RUNTIME_MANIFEST_REL), 'utf8'),
  ) as RuntimeManifest;
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));

  describe('the closure was actually computed (non-vacuity)', () => {
    it('parses every allowlist entry the script text contains', () => {
      expect(pinPaths.length).toBe(countQuotedFilesEntries(scriptText));
      // Floor, not an exact count: the allowlist is expected to grow.
      expect(pinPaths.length).toBeGreaterThanOrEqual(30);
      for (const pinPath of pinPaths) expect(pinPath).toMatch(/^(deploy|src)\//);
    });

    it('does not stop at a parenthesis inside the array', () => {
      // Regression control. Terminating on the first `)` after `FILES=(`
      // instead of on a line that IS `)` truncates the allowlist at the first
      // comment that contains one, and a truncated allowlist under-seeds the
      // closure while every assertion below still passes.
      const truncating = scriptText.replace(
        '\nFILES=(\n',
        '\nFILES=(\n  # a comment with a close paren -> here\n',
      );
      expect(truncating).not.toBe(scriptText);
      expect(parseDeployPinPaths(truncating)).toEqual(pinPaths);
    });

    it('parsed every python allowlist member with python ast', () => {
      const pythonSeeds = pinPaths.filter((pinPath) => pinPath.endsWith('.py'));
      expect(pythonSeeds.length).toBeGreaterThan(0);
      for (const seed of pythonSeeds) expect(closure.pythonParsed).toContain(seed);
    });

    it('resolved every relative TypeScript specifier it walked', () => {
      // An unresolved specifier is a hole in the graph: the closure would be
      // missing whatever lives behind it and would still look clean.
      expect(closure.unresolvedTsSpecifiers).toEqual([]);
      const tsSeeds = pinPaths.filter((pinPath) => pinPath.endsWith('.ts'));
      expect(tsSeeds.length).toBeGreaterThan(0);
      for (const seed of tsSeeds) expect(closure.tsParsed).toContain(seed);
    });

    it('found real import edges in both languages', () => {
      // A closed allowlist makes the closure EQUAL the seed set, so closure
      // size proves nothing. Edge count does: a walk that parsed nothing would
      // report zero edges and a trivially "closed" closure.
      expect(closure.closure.length).toBe(new Set(pinPaths).size);
      expect(closure.edges.length).toBeGreaterThanOrEqual(20);
      const edge = (from: string, to: string): boolean =>
        closure.edges.some((item) => item.from === from && item.to === to);
      // Python module-scope import.
      expect(
        edge('deploy/scripts/bot-errors-dispatcher.py', 'deploy/scripts/lib/durable_json.py'),
      ).toBe(true);
      // TypeScript value import (an `import type` edge is erased at runtime and
      // is deliberately not counted).
      expect(edge('src/lib/bot-errors-outbox.ts', 'src/lib/type-guards.ts')).toBe(true);
      // Sibling loaded by file path, not by import statement.
      expect(
        edge(
          'deploy/scripts/bot-errors-health-check.py',
          'deploy/scripts/bot-errors-tree-provenance.py',
        ),
      ).toBe(true);
    });

    it('reports members that a shrunken allowlist would leave unshipped', () => {
      // Negative control: seed with the outbox alone and the walk must surface
      // its four dependencies. If this returns nothing, the machinery cannot
      // detect an open closure and every green result above is meaningless.
      const shrunken = computeImportClosure(repoRoot, ['src/lib/bot-errors-outbox.ts']);
      expect(shrunken.uncovered).toEqual([
        'src/lib/alert-evidence.ts',
        'src/lib/private-fs.ts',
        'src/lib/redaction-patterns.ts',
        'src/lib/type-guards.ts',
      ]);
    });
  });

  it('ships every module the allowlisted files import', () => {
    expect(
      closure.uncovered,
      `imported by a managed file but never deployed: ${closure.uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('ships the sibling script bot-errors-health-check loads by file path', () => {
    // health-check.py resolves this hyphenated sibling through
    // importlib.util.spec_from_file_location and returns None when it is
    // absent, so an unshipped copy degrades silently instead of failing.
    expect(pinPaths).toContain('deploy/scripts/bot-errors-tree-provenance.py');
  });

  it('backs every allowlist entry with a runtime-manifest entry', () => {
    // resolve_managed_files() exits 3 when an allowlisted path has no manifest
    // hash, so this containment is a hard runtime precondition of the deployer,
    // not a style rule.
    const unpinned = pinPaths.filter((pinPath) => !manifestPaths.has(pinPath));
    expect(
      unpinned,
      `allowlisted without a runtime-manifest hash (deployer exits 3): ${unpinned.join(', ')}`,
    ).toEqual([]);
  });
});
