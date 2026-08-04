/**
 * Fleet-route test-harness SSOT ratchet — ensures no tests/fleet/ file
 * defines a local OpsDeps builder instead of consuming makeDeps() from
 * tests/helpers/http-mocks.ts.
 *
 * #2240 tracks the migration of 15 local OpsDeps builders to the shared
 * makeDeps harness. After harness extension (discovery.scan default +
 * startFire auto-invoke), every local builder that existed solely to patch
 * those two gaps can collapse to (at most) a one-line wrapper or a bare
 * makeDeps() call. This ratchet locks the count at baseline 0, preventing
 * re-invention of standalone builders.
 *
 * DESIGN LIMITATION (known, accepted): tests/fleet/ops-settings-json.test.ts
 * builds OpsDeps objects inline 7 separate times — no named function, so
 * this name-based ratchet never flags it. That file's OpsDeps duplication
 * is NOT eliminated by this test. Tracked separately.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fleetTestRoot = resolve(repoRoot, 'tests/fleet');

const OPSDEPS_BUILDER_BUDGET = 0;

// Files excluded by design — see header or the tracking issue for rationale.
// ops.test.ts: Wave 4 builder, held per gate sequencing.
const EXCLUDED = new Set<string>([
  // Builder 15 (179 call sites) — held per gate sequencing (#2240 Wave 4).
  'tests/fleet/routes/ops.test.ts',
]);

// Match local OpsDeps builder function or const declarations.
// A builder is "local" (an offender) if it does NOT delegate to the shared
// makeDeps() — i.e. its body contains a hand-rolled object literal rather
// than `return makeDeps(`.
const OPSDEPS_BUILDER = /(?:function|const)\s+(makeDeps|depsFor|successDeps|failingDeps|succeedingDeps)\b/;
const USES_SHARED_MAKEDEPS = /return\s+makeDeps\s*(?:<[^>]*>)?\s*\(/;

function collectFleetTestFiles(): string[] {
  return readdirSync(fleetTestRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.test.ts'))
    .map((d) => resolve(d.parentPath || fleetTestRoot, d.name));
}

interface BuilderSite {
  file: string;
}

function findOffendingBuilders(): BuilderSite[] {
  const files = collectFleetTestFiles();
  if (files.length === 0) {
    throw new Error('Scanned zero tests/fleet/**/*.test.ts files — ratchet would be vacuous');
  }
  const sites: BuilderSite[] = [];
  for (const file of files) {
    const relPath = file.replace(repoRoot + '/', '');
    if (EXCLUDED.has(relPath)) continue;
    const src = readFileSync(file, 'utf8');
    // Only flag files that also reference OpsDeps (avoids false-positives on
    // unrelated makeDeps-named helpers elsewhere).
    if (!src.includes('OpsDeps')) continue;
    if (OPSDEPS_BUILDER.test(src) && !USES_SHARED_MAKEDEPS.test(src)) {
      sites.push({ file: relPath });
    }
  }
  return sites;
}

describe('fleet-route test-harness SSOT ratchet', () => {
  it('no tests/fleet/ file defines a local OpsDeps builder (use shared makeDeps)', () => {
    const sites = findOffendingBuilders();
    if (sites.length > OPSDEPS_BUILDER_BUDGET) {
      const breakdown = sites
        .map((s) => `  ${s.file}`)
        .join('\n');
      expect(
        sites,
        `${sites.length} tests/fleet/ file(s) still define a local OpsDeps builder instead of ` +
          `consuming makeDeps() from tests/helpers/http-mocks.ts:\n${breakdown}`,
      ).toHaveLength(OPSDEPS_BUILDER_BUDGET);
    }
    expect(sites).toHaveLength(OPSDEPS_BUILDER_BUDGET);
  });
});
