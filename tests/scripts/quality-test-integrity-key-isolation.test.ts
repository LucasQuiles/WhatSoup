/**
 * The private test-integrity check runs only in the trusted `private-test-integrity.yml` workflow.
 *
 * The Quality workflow runs the change's own code (`npm ci` install scripts, then its npm scripts),
 * so none of its jobs may hold the test-integrity deploy key, fetch or install the private plugin,
 * or run the test-integrity guard. The trusted workflow runs the pinned plugin after Quality
 * completes: it posts `test-integrity (private)` for same-repository pull requests and records a
 * receipt for other runs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowsDir = join(repoRoot, '.github/workflows');
const quality = parse(readFileSync(join(workflowsDir, 'quality.yml'), 'utf8')) as {
  jobs: Record<string, unknown>;
};

describe('Quality holds no test-integrity deploy key or plugin', () => {
  it.each([
    'TEST_INTEGRITY_DEPLOY_KEY',
    'LucasQuiles/test-integrity',
    '.claude/plugins/test-integrity',
    'guard:test-integrity',
  ])('no Quality job references %s', (reference) => {
    const holders = Object.entries(quality.jobs)
      .filter(([, job]) => JSON.stringify(job).includes(reference))
      .map(([id]) => id);

    expect(holders).toEqual([]);
  });

  it('names the deploy key only in the trusted private workflow', () => {
    const holders = readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) => readFileSync(join(workflowsDir, file), 'utf8').includes('TEST_INTEGRITY_DEPLOY_KEY'))
      .sort();

    expect(holders).toEqual(['private-test-integrity.yml']);
  });
});
