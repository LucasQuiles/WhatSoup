import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEPLOY_SCRIPT_REL,
  parseDeployPinPaths,
} from '../../scripts/lib/deployer-import-closure.ts';
import { BRANCH_STEPS, CURATED_TEST_PATHS } from '../../scripts/push-gate.ts';

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
    expect(pinPaths).toContain('deploy/scripts/lib/bounded_jsonl.py');
    expect(pinPaths).toContain('deploy/lib/runtime-path.sh');
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
    const chain = BRANCH_STEPS.map((step) => step.cmd).join(' && ');
    expect(chain, 'verify:push:branch must exist').toBeTruthy();
    expect(chain).toContain('npm run guard:deployer-static');
  });

  // The assertion that used to sit here derived `coveredPaths` from `pinPaths`
  // and then asserted `pinPaths` was contained in it -- `FILES ⊆ FILES`, true
  // no matter how broken the pin set was. It was deleted rather than repaired
  // because the property it was reaching for is already proven twice over: the
  // test above proves guard:deployer-static is wired into the gate, and
  // guard:deployer-static runs the same deploy.sh `verify`, so wiring alone
  // gives local coverage of every current and future pin. What the tautology
  // could never check -- whether the pin set is COMPLETE -- needs the import
  // graph, and that lives in tests/scripts/deployer-import-closure.test.ts.
  it('runs the import-closure check in the same gate', () => {
    // Whether a pin is locally covered is settled above. Whether the pin LIST
    // is closed under import is a different question, and the check that
    // answers it has to run in the gate too or the gap simply reopens there.
    expect(CURATED_TEST_PATHS).toContain('tests/scripts/deployer-import-closure.test.ts');
  });
});
