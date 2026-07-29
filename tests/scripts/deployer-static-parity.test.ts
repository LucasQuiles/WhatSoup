import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// BEAD-039: local/CI parity guard.
//
// The deployer static guard (`whatsoup-bot-errors-deploy.sh verify <root>`)
// pins the sha256 of N critical bot-errors files. Historically it ran ONLY in
// CI (via run-sentinel-tests.sh), so an edit to any pinned file passed the full
// local suite and only failed after a CI round-trip — the gap that twice
// red-flagged PR #1397.
//
// This test enforces the structural invariant that closes that gap: every path
// in the deploy.sh `FILES=()` pin list must be covered by a guard that is wired
// into `verify:push:branch`. With `guard:deployer-static` running the very same
// deploy.sh `verify` over the working tree, that guard's covered-path set is the
// deploy.sh pin set by construction — so the containment holds as long as the
// guard stays wired. A NEW pin therefore cannot silently become CI-only again.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const DEPLOY_SCRIPT_REL = 'deploy/scripts/whatsoup-bot-errors-deploy.sh';

/**
 * Parse the `FILES=( ... )` bash array out of the deployer script and return
 * every pin path in it.
 *
 * Each entry is a quoted bare path (e.g. `"deploy/scripts/foo.py"`) -- the
 * expected sha256 for each is resolved at the deployer's runtime from
 * deploy/bot-errors-runtime-manifest.json (the single source of truth),
 * not embedded here. Splitting on the first `:` is still correct and kept
 * for robustness against a legacy or hand-edited `"path:sha256"` entry,
 * but no current entry has a `:` suffix to split off.
 */
function parseDeployPinPaths(scriptText: string): string[] {
  const open = scriptText.indexOf('FILES=(');
  if (open === -1) {
    throw new Error(`could not locate FILES=( ... ) in ${DEPLOY_SCRIPT_REL}`);
  }
  const close = scriptText.indexOf(')', open);
  if (close === -1) {
    throw new Error(`unterminated FILES=( ... ) in ${DEPLOY_SCRIPT_REL}`);
  }
  const body = scriptText.slice(open + 'FILES=('.length, close);
  const paths: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const unquoted = line.replace(/^["']/, '').replace(/["']$/, '');
    const pinPath = unquoted.split(':')[0]?.trim();
    if (pinPath) {
      paths.push(pinPath);
    }
  }
  return paths;
}

describe('deployer-static parity (BEAD-039)', () => {
  const scriptText = readFileSync(path.join(repoRoot, DEPLOY_SCRIPT_REL), 'utf8');
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  it('parses a non-empty pin list from the deployer FILES=() array', () => {
    const pinPaths = parseDeployPinPaths(scriptText);
    expect(pinPaths.length).toBeGreaterThan(0);
    expect(pinPaths).toContain('src/lib/fault-taxonomy-registry.json');
    expect(pinPaths).toContain('deploy/scripts/lib/bot_errors_envelope.py');
    // Sanity: every pin is a repo-relative path with a recognizable surface.
    for (const p of pinPaths) {
      expect(p).toMatch(/^(deploy|src)\//);
    }
  });

  it('defines guard:deployer-static and points it at the deployer verify', () => {
    const guard = pkg.scripts['guard:deployer-static'];
    expect(guard, 'guard:deployer-static must be defined in package.json').toBeTruthy();
    expect(guard).toContain(DEPLOY_SCRIPT_REL);
    expect(guard).toContain('verify');
  });

  it('wires guard:deployer-static into verify:push:branch', () => {
    const chain = pkg.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch must exist').toBeTruthy();
    expect(chain).toContain('npm run guard:deployer-static');
  });

  it('covers every deploy.sh pinned path via a locally-wired guard', () => {
    const pinPaths = parseDeployPinPaths(scriptText);
    const chain = pkg.scripts['verify:push:branch'] ?? '';
    const guardWired = chain.includes('npm run guard:deployer-static');
    // guard:deployer-static runs the SAME deploy.sh `verify`, so its covered set
    // is exactly the deploy.sh pin set. If it is wired, containment holds for
    // every current pin AND any future pin added to FILES=().
    const coveredPaths = new Set(guardWired ? pinPaths : []);
    const uncovered = pinPaths.filter((p) => !coveredPaths.has(p));
    expect(uncovered, `pins not covered by a wired guard: ${uncovered.join(', ')}`).toEqual([]);
  });
});
