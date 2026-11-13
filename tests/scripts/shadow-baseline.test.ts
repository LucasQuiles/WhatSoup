import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function combinedFixture(eslintExit = 0, inventoryExit = 0) {
  const root = tmp.make('combined');
  const scripts = join(root, 'scripts');
  const eslint = join(root, 'node_modules/eslint/bin');
  const bin = join(root, 'bin');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(eslint, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(scripts, 'check-shadow-baseline.mjs'), readFileSync(SCRIPT));
  writeFileSync(join(root, 'lint-shadow-baseline.json'), JSON.stringify({ total: 0, rules: {} }));
  writeFileSync(join(eslint, 'eslint.js'), `require('node:fs').appendFileSync('eslint-calls', 'scan\\n'); console.log('[]'); process.exit(${eslintExit});`);
  writeFileSync(join(bin, 'npx'), '#!/usr/bin/env node\nrequire("../node_modules/eslint/bin/eslint.js");\n', { mode: 0o700 });
  for (const [name, exit] of [['shadow-frozen', inventoryExit], ['raw-form-control', 0]] as const) {
    writeFileSync(join(scripts, `check-${name}-inventory.mjs`), `
import { readFileSync, writeFileSync } from 'node:fs';
const report = process.argv[process.argv.indexOf('--eslint-json') + 1];
writeFileSync('${name}-observation', JSON.stringify({ report, bytes: readFileSync(report, 'utf8') }));
process.exit(${exit});
`);
  }
  const execute = (args: string[] = ['--with-inventories']) => spawnSync(process.execPath,
    [join(scripts, 'check-shadow-baseline.mjs'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return { root, execute };
}

const oneWarning = [
  { filePath: 'src/Foo.tsx', messages: [{ message: '[soup/no-bad-thing] nope', ruleId: 'no-restricted-syntax' }] },
];
const KEY = 'soup/no-bad-thing :: src/Foo.tsx';

describe('check-shadow-baseline.mjs', () => {
  it('scans once, shares identical bytes with both inventories, and removes the report', () => {
    const { root, execute } = combinedFixture();
    const result = execute();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'eslint-calls'), 'utf8')).toBe('scan\n');
    const frozen = JSON.parse(readFileSync(join(root, 'shadow-frozen-observation'), 'utf8'));
    expect(JSON.parse(readFileSync(join(root, 'raw-form-control-observation'), 'utf8'))).toEqual(frozen);
    expect(frozen.bytes).toBe('[]\n');
    expect(existsSync(frozen.report)).toBe(false);
  });

  it('preserves inventory failure, stops later checks, and removes its report', () => {
    const { root, execute } = combinedFixture(0, 23);
    const result = execute();
    expect(result.status).toBe(23);
    expect(existsSync(join(root, 'raw-form-control-observation'))).toBe(false);
    const frozen = JSON.parse(readFileSync(join(root, 'shadow-frozen-observation'), 'utf8'));
    expect(existsSync(frozen.report)).toBe(false);
  });

  it('refuses operational ESLint failure even when stdout is valid JSON', () => {
    const { root, execute } = combinedFixture(2);
    const result = execute();
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(root, 'eslint-calls'), 'utf8')).toBe('scan\n');
    expect(existsSync(join(root, 'shadow-frozen-observation'))).toBe(false);
    expect(result.stdout).not.toContain('shadow baseline OK');
  });

  it.each([{ args: ['--update'] }, { args: ['--results-json', 'stale.json'] }])('refuses combined report reuse or baseline mutation: $args', ({ args }) => {
    const { root, execute } = combinedFixture();
    const baseline = readFileSync(join(root, 'lint-shadow-baseline.json'), 'utf8');
    const result = execute(['--with-inventories', ...args]);
    expect(result.status).toBe(2);
    expect(existsSync(join(root, 'eslint-calls'))).toBe(false);
    expect(readFileSync(join(root, 'lint-shadow-baseline.json'), 'utf8')).toBe(baseline);
  });

  it('runs the combined live check through the maintained design command', () => {
    const command = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).scripts['verify:console-design:live'];
    expect(command).toContain('run lint:shadow:baseline -- --with-inventories');
    expect(command).not.toContain('run design:shadow-frozen-inventory');
    expect(command).not.toContain('run design:raw-form-control-inventory');
    const result = run(['--with-inventories']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/shadow baseline OK: \d+ warnings \(ceiling \d+\)/);
    expect(result.stdout.match(/"verdict": "PASS"/g)).toHaveLength(2);
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
