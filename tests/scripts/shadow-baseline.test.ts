import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-shadow-baseline.mjs');

const tmp = trackTmpDirs('shadow-');

// A captured eslint --format json array. filePath does not start with consoleRoot,
// so the script keys the ratchet by the literal path — the same parse/tag/compare
// path the real run uses, just fed from a fixture.
function fixture(results: unknown, baseline: unknown) {
  const dir = tmp.make('baseline');
  const resultsPath = join(dir, 'results.json');
  const baselinePath = join(dir, 'baseline.json');
  writeFileSync(resultsPath, JSON.stringify(results));
  writeFileSync(baselinePath, JSON.stringify(baseline));
  return { resultsPath, baselinePath };
}

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

const oneWarning = [
  { filePath: 'src/Foo.tsx', messages: [{ message: '[soup/no-bad-thing] nope', ruleId: 'no-restricted-syntax' }] },
];
const KEY = 'soup/no-bad-thing :: src/Foo.tsx';

describe('check-shadow-baseline.mjs', () => {
  it('passes the real shadow lint run against the committed baseline (default, no flags)', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/shadow baseline OK: \d+ warnings \(ceiling \d+\)/);
  }, 30_000);

  it('passes when injected results equal the injected baseline', () => {
    const { resultsPath, baselinePath } = fixture(oneWarning, { total: 1, rules: { [KEY]: 1 } });
    const result = run(['--results-json', resultsPath, '--baseline', baselinePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('shadow baseline OK');
  });

  it('fails when an injected result exceeds its baseline ceiling', () => {
    const { resultsPath, baselinePath } = fixture(oneWarning, { total: 0, rules: {} });
    const result = run(['--results-json', resultsPath, '--baseline', baselinePath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exceeded the shadow baseline');
    expect(result.stderr).toContain(KEY);
  });

  it('fails closed when an injected result falls below its ceiling without --update (no reusable slack)', () => {
    const { resultsPath, baselinePath } = fixture(oneWarning, { total: 2, rules: { [KEY]: 2 } });
    const result = run(['--results-json', resultsPath, '--baseline', baselinePath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FALL: ${KEY} -> 1 warnings (ceiling 2, -1)`);
    expect(result.stderr).toContain('run with --update to lower the baseline');
  });

  it('refuses --results-json combined with --update so a fixture can never write a baseline', () => {
    const { resultsPath, baselinePath } = fixture(oneWarning, { total: 0, rules: {} });
    const result = run(['--results-json', resultsPath, '--baseline', baselinePath, '--update']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot be combined with --update');
  });
});
