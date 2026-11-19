import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkSafeguards, type DiagnosticCheck } from '../../scripts/safeguard-diagnostics.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = trackTmpDirs('');
const QUALITY_WORKFLOW = '.github/workflows/quality.yml';
const workflow = readFileSync(path.join(repoRoot, QUALITY_WORKFLOW), 'utf8');

// The lane-partition check reads only the Quality workflow; checkSafeguards also
// loads both package manifests, so the tree holds those three files. Every other
// check fails in such a tree, so only the lane-partition result is asserted.
function lanePartitionCheck(workflowText: string): DiagnosticCheck | undefined {
  const tree = tmp.make('safeguard-macos-lane');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ scripts: {} }),
    'console/package.json': JSON.stringify({ scripts: {} }),
    [QUALITY_WORKFLOW]: workflowText,
  };
  for (const [relativePath, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tree, relativePath)), { recursive: true });
    writeFileSync(path.join(tree, relativePath), text);
  }
  return checkSafeguards(tree).checks.find((check) => check.id === 'quality-ci-lane-partition');
}

describe('safeguard diagnostics: macOS Quality lane', () => {
  // The rejecting case below is only meaningful while the unmutated lane passes.
  it('accepts the macOS lane with its exact runner and prerequisite test command', () => {
    expect(lanePartitionCheck(workflow)).toMatchObject({ status: 'pass' });
  });

  it('fails when Quality changes the macOS prerequisite test command', () => {
    const mutated = workflow.replace(
      'tests/scripts/bot-errors-release-proof-run.test.ts',
      'tests/scripts/bot-errors-release-proof-run-retired.test.ts',
    );
    expect(mutated).not.toBe(workflow);

    expect(lanePartitionCheck(mutated)).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining([
        'bot-errors-health-macos must run the portable Python and release-proof prerequisite suites exactly once',
      ]),
    });
  });
});
