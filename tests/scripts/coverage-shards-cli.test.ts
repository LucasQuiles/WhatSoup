import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('coverage-shard-cli-');
const command = resolve('scripts/coverage-shards.ts');

function fixture(runTimeoutMs = 30_000) {
  const cwd = tmp.make('repo');
  const output = tmp.make('artifacts');
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'tests'));
  mkdirSync(join(cwd, 'console'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
  writeFileSync(join(cwd, 'package-lock.json'), '{}');
  writeFileSync(join(cwd, 'console/package-lock.json'), '{}');
  writeFileSync(join(cwd, '.gitignore'), 'coverage/\nnode_modules/\n.local/\n');
  writeFileSync(join(cwd, 'src/main.ts'), 'export const choose = (value: boolean) => value ? 1 : 2;\n');
  writeFileSync(join(cwd, 'tests/a.test.ts'), "import { choose } from '../src/main.ts'; test('true', () => { expect(process.env.NODE_DISABLE_COMPILE_CACHE).toBe('1'); expect(choose(true)).toBe(1); });\n");
  writeFileSync(join(cwd, 'tests/b.test.ts'), "import { choose } from '../src/main.ts'; test('false', () => expect(choose(false)).toBe(2));\n");
  writeFileSync(join(cwd, 'vitest.config.ts'), `export default { test: {
    globals: true, include: ['tests/*.test.ts'], coverage: { provider: 'v8', include: ['src/*.ts'],
    thresholds: { lines: 95, branches: 90, functions: 93 } }
  } };\n`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, timeout: 10_000, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const runWithEnv = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [command, ...args], {
    cwd, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', ...env },
    encoding: 'utf8', timeout: runTimeoutMs, maxBuffer: 2 * 1024 * 1024,
  });
  const run = (...args: string[]) => runWithEnv({}, ...args);
  return { cwd, output, plan: join(output, 'plan.json'), run, runWithEnv };
}

describe('native coverage shard commands', () => {
  it.each([['failed', 0], ['busy', 0], ['timedOut', 0], ['inconclusive', 0], ['passed', 1], ['busy', 1]])('rejects a forged %s terminal record with native exit %s', (outcome, exitCode) => {
    const { plan, output, runWithEnv } = fixture();
    const preload = join(output, 'forged-terminal.cjs');
    writeFileSync(preload, `if ((process.argv[1] || '').endsWith('/coverage-shard-worker.ts')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ operation: 'plan', outcome, exitCode }))});
  process.exit(${exitCode});
}\n`);
    const result = runWithEnv({ NODE_OPTIONS: `--require=${preload}` }, 'plan', '--out', plan);
    expect(result.status).toBe(125);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'inconclusive', exitCode: 125 });
    expect(existsSync(plan)).toBe(false);
  });

  it('does not copy unrelated caller credentials into the coverage worker', () => {
    const { plan, output, runWithEnv } = fixture();
    const observation = join(output, 'worker-environment.json');
    const preload = join(output, 'worker-environment.cjs');
    writeFileSync(preload, `if ((process.argv[1] || '').endsWith('/coverage-shard-worker.ts')) {
  require('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
    inherited: process.env.UNRELATED_COVERAGE_SECRET !== undefined,
    compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE
  }));
}\n`);
    const result = runWithEnv({ NODE_OPTIONS: `--require=${preload}`, UNRELATED_COVERAGE_SECRET: 'must-stay-in-parent' }, 'plan', '--out', plan);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({ inherited: false, compileCacheDisabled: '1' });
  });

  it.each(['mkdtempSync', 'openSync'])('keeps parent %s filesystem stalls outside the result path', (method) => {
    const { plan, output, runWithEnv } = fixture(6000);
    const preload = join(output, 'parent-filesystem.cjs');
    writeFileSync(preload, `const fs = require('node:fs');
const original = fs[${JSON.stringify(method)}];
fs[${JSON.stringify(method)}] = function (path, ...args) {
  if (process.argv[1] === ${JSON.stringify(command)} && String(path).includes('coverage-command-')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
  return original.call(this, path, ...args);
};
require('node:module').syncBuiltinESMExports();\n`);
    const result = runWithEnv({ NODE_OPTIONS: `--require=${preload}` }, 'plan', '--out', plan, '--timeout-ms', '3000');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'passed', operation: 'plan', completeCoverage: false });
    expect(JSON.parse(readFileSync(plan, 'utf8')).shards.flat().sort()).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('rejects an initial plan symlink before creating shard output', () => {
    const { plan, output, run } = fixture();
    expect(run('plan', '--out', plan).status).toBe(0);
    const link = join(output, 'linked-plan.json');
    symlinkSync(plan, link);
    const result = run('shard', '--plan', link, '--index', '1', '--out', join(output, 'shard-1'));
    expect(result.status, result.stderr).toBe(125);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'inconclusive' });
    expect(existsSync(join(output, 'shard-1'))).toBe(false);
  });

  it.each(['symlink', 'FIFO', 'changed content'])('rejects a plan replaced with %s after admission', (replacement) => {
    const { cwd, plan, output, run } = fixture(10_000);
    const config = join(cwd, 'vitest.config.ts');
    const existing = readFileSync(config, 'utf8');
    writeFileSync(config, `import { renameSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const plan = process.env.WHATSOUP_COVERAGE_PLAN;
if (plan) {
  renameSync(plan, plan + '.original');
  const kind = ${JSON.stringify(replacement)};
  if (kind === 'symlink') symlinkSync(plan + '.original', plan);
  else if (kind === 'FIFO') execFileSync('mkfifo', [plan], { timeout: 1000 });
  else {
    const changed = JSON.parse(readFileSync(plan + '.original', 'utf8'));
    changed.shards.reverse();
    writeFileSync(plan, JSON.stringify(changed));
  }
}
${existing}`);
    expect(run('plan', '--out', plan).status).toBe(0);
    const result = run('shard', '--plan', plan, '--index', '1', '--out', join(output, 'shard-1'), '--timeout-ms', '6000');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'failed', operation: 'shard' });
    const report = JSON.parse(readFileSync(join(output, 'shard-1', 'report.json'), 'utf8'));
    expect(report.testResults).toEqual([]);
    expect(result.stderr).toMatch(/Invalid coverage artifact|plan changed after admission/);
    expect(existsSync(join(output, 'shard-1', 'receipt.json'))).toBe(false);
  });

  it.each(['package-lock.json', 'console/package-lock.json', 'vitest.config.ts'])('rejects symlinked identity input %s', (file) => {
    const { cwd, plan, output, run } = fixture();
    const path = join(cwd, file);
    const original = join(output, 'identity-input');
    writeFileSync(original, readFileSync(path));
    unlinkSync(path);
    symlinkSync(original, path);
    const result = run('plan', '--out', plan);
    expect(result.status).toBe(125);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'inconclusive', operation: 'plan' });
    expect(existsSync(plan)).toBe(false);
  });

  it('materializes the actual native inventory and refuses changed source before execution', () => {
    const { cwd, plan, output, run } = fixture();
    const planned = run('plan', '--out', plan, '--max-workers', '1');
    expect(planned.status, planned.stderr).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({ completeCoverage: false, consoleCoverage: 'not-run' });
    const data = JSON.parse(readFileSync(plan, 'utf8'));
    expect(data.shards.flat().sort()).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(data.identity).toMatchObject({ root: cwd, workers: 1, vitest: '4.1.11', node: process.version });
    writeFileSync(join(cwd, 'src/main.ts'), 'export const choose = () => 3;\n');
    const shardOutput = join(output, 'shard-1');
    const refused = run('shard', '--plan', plan, '--index', '1', '--out', shardOutput);
    expect(refused.status).toBe(125);
    expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: 'inconclusive', operation: 'shard' });
    expect(existsSync(join(shardOutput, 'receipt.json'))).toBe(false);
  });

  it('runs two isolated native blobs and enforces thresholds only on their complete merge', () => {
    const { cwd, plan, output, run } = fixture();
    const planned = run('plan', '--out', plan, '--max-workers', '1');
    expect(planned.status, planned.stderr).toBe(0);
    for (const index of ['1', '2']) {
      const shard = run('shard', '--plan', plan, '--index', index, '--out', join(output, `shard-${index}`), '--timeout-ms', '20000');
      expect(shard.status, shard.stderr).toBe(0);
      expect(JSON.parse(shard.stdout)).toMatchObject({ outcome: 'passed', operation: 'shard', completeCoverage: false });
    }
    const merged = run('merge', '--plan', plan, '--receipts', output, '--timeout-ms', '20000');
    expect(merged.status, merged.stderr).toBe(0);
    expect(JSON.parse(merged.stdout)).toMatchObject({ outcome: 'passed', operation: 'merge', completeCoverage: true, consoleCoverage: 'not-run', tests: { passed: 2, total: 2 } });
    const summary = JSON.parse(readFileSync(join(cwd, 'coverage/coverage-summary.json'), 'utf8'));
    expect(summary.total.branches.pct).toBe(100);
    expect(summary.total.functions.pct).toBe(100);
  }, 30_000);

  it('fails the normal merge command when complete coverage misses the unchanged floors', () => {
    const { cwd, plan, output, run } = fixture();
    writeFileSync(join(cwd, 'src/main.ts'), 'export const choose = (value: boolean) => value ? 1 : 2;\nexport const unused = () => 3;\n');
    const planned = run('plan', '--out', plan, '--max-workers', '1');
    expect(planned.status, planned.stderr).toBe(0);
    for (const index of ['1', '2']) {
      const shard = run('shard', '--plan', plan, '--index', index, '--out', join(output, `shard-${index}`), '--timeout-ms', '20000');
      expect(shard.status, shard.stderr).toBe(0);
    }
    const merged = run('merge', '--plan', plan, '--receipts', output, '--timeout-ms', '20000');
    expect(merged.status).toBe(1);
    expect(JSON.parse(merged.stdout)).toMatchObject({ outcome: 'failed', operation: 'merge', tests: { passed: 2, total: 2 } });
    const summary = JSON.parse(readFileSync(join(cwd, 'coverage/coverage-summary.json'), 'utf8'));
    expect(summary.total.functions.pct).toBe(50);
  }, 30_000);

  it.each(['foreign-artifacts', 'symlinked-shard'])('rejects %s despite valid identities and artifact hashes', (mode) => {
    const { cwd, plan, output, run } = fixture();
    expect(run('plan', '--out', plan, '--max-workers', '1').status).toBe(0);
    for (const index of ['1', '2']) {
      const shard = run('shard', '--plan', plan, '--index', index, '--out', join(output, `shard-${index}`), '--timeout-ms', '20000');
      expect(shard.status, shard.stderr).toBe(0);
    }
    const shardPath = join(output, 'shard-1');
    const foreign = join(output, 'foreign');
    if (mode === 'symlinked-shard') {
      renameSync(shardPath, foreign);
      symlinkSync(foreign, shardPath);
    } else {
      mkdirSync(foreign);
      const receiptPath = join(shardPath, 'receipt.json');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      copyFileSync(receipt.blobPath, join(foreign, 'blob.json'));
      copyFileSync(receipt.reportPath, join(foreign, 'report.json'));
      receipt.blobPath = join(foreign, 'blob.json');
      receipt.reportPath = join(foreign, 'report.json');
      writeFileSync(receiptPath, JSON.stringify(receipt));
    }
    const merged = run('merge', '--plan', plan, '--receipts', output, '--timeout-ms', '20000');
    expect(merged.status).toBe(125);
    expect(JSON.parse(merged.stdout)).toMatchObject({ outcome: 'inconclusive', operation: 'merge' });
    expect(existsSync(join(cwd, 'coverage/coverage-final.json'))).toBe(false);
  }, 30_000);

  it('rejects a missing shard through the normal merge entry point before writing coverage', () => {
    const { cwd, plan, output, run } = fixture();
    const planned = run('plan', '--out', plan, '--max-workers', '1');
    expect(planned.status, planned.stderr).toBe(0);
    const shard = run('shard', '--plan', plan, '--index', '1', '--out', join(output, 'shard-1'), '--timeout-ms', '20000');
    expect(shard.status, shard.stderr).toBe(0);
    const merged = run('merge', '--plan', plan, '--receipts', output, '--timeout-ms', '20000');
    expect(merged.status).toBe(125);
    expect(JSON.parse(merged.stdout)).toMatchObject({ outcome: 'inconclusive', operation: 'merge' });
    expect(existsSync(join(cwd, 'coverage/coverage-final.json'))).toBe(false);
  }, 30_000);

  it('rejects foreign timing paths instead of falsely claiming measured balance', () => {
    const { plan, output, run } = fixture();
    const timings = join(output, 'timings.json');
    writeFileSync(timings, JSON.stringify({
      success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
      numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
      testResults: [{ name: '/foreign/tests/a.test.ts', startTime: 1, endTime: 2, status: 'passed', assertionResults: [{ status: 'passed' }] }],
    }));
    const planned = run('plan', '--out', plan, '--timings', timings);
    expect(planned.status).toBe(125);
    expect(JSON.parse(planned.stdout)).toMatchObject({ outcome: 'inconclusive', operation: 'plan' });
    expect(existsSync(plan)).toBe(false);
  });

  it('preserves a native failure when the failing test also changes source', () => {
    const { cwd, plan, output, run } = fixture();
    writeFileSync(join(cwd, 'tests/a.test.ts'), `import { writeFileSync } from 'node:fs';
test('mutates source then fails', () => {
  writeFileSync(new URL('../src/main.ts', import.meta.url), 'export const choose = () => 9;\\n');
  expect(1).toBe(2);
});\n`);
    const planned = run('plan', '--out', plan, '--max-workers', '1');
    expect(planned.status, planned.stderr).toBe(0);
    const data = JSON.parse(readFileSync(plan, 'utf8'));
    const index = data.shards.findIndex((files: string[]) => files.includes('tests/a.test.ts')) + 1;
    const shardOutput = join(output, `shard-${index}`);
    const failed = run('shard', '--plan', plan, '--index', String(index), '--out', shardOutput, '--timeout-ms', '20000');
    expect(failed.status, failed.stderr).toBe(1);
    const result = JSON.parse(failed.stdout);
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 1, completeCoverage: false });
    expect(result.error).toContain('FINAL-SOURCE drift:');
    expect(result.results[0]).toMatchObject({ exitCode: 1, outcome: 'failed' });
    expect(existsSync(join(shardOutput, 'receipt.json'))).toBe(false);
  });

  it('rejects duplicate timing names instead of silently replacing their measurement', () => {
    const { cwd, plan, output, run } = fixture();
    const timings = join(output, 'timings.json');
    writeFileSync(timings, JSON.stringify({
      success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
      numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
      testResults: [1, 100].map((duration) => ({ name: join(cwd, 'tests/a.test.ts'), startTime: 0, endTime: duration,
        status: 'passed', assertionResults: [{ status: 'passed' }] })),
    }));
    const planned = run('plan', '--out', plan, '--timings', timings);
    expect(planned.status, planned.stderr).toBe(125);
    expect(JSON.parse(planned.stdout).error).toMatch(/duplicate.*timing/i);
    expect(existsSync(plan)).toBe(false);
  });

  it('refuses a FIFO plan without waiting for a writer or reporting success', () => {
    const { plan, output, run } = fixture(5000);
    execFileSync('mkfifo', [plan], { timeout: 1000 });
    const refused = run('shard', '--plan', plan, '--index', '1', '--out', join(output, 'shard-1'), '--timeout-ms', '1000');
    expect(refused.error).toBeUndefined();
    expect(refused.status, refused.stderr).toBe(125);
    expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: 'inconclusive' });
    expect(existsSync(join(output, 'shard-1'))).toBe(false);
  });

  it('bounds a stalled artifact read before the native test process starts', () => {
    const { plan, output, run, runWithEnv } = fixture(5000);
    expect(run('plan', '--out', plan).status).toBe(0);
    const preload = join(output, 'slow-filesystem.cjs');
    writeFileSync(preload, `const fs = require('node:fs');
const original = fs.lstatSync;
fs.lstatSync = function (path, ...args) {
  if (String(path) === ${JSON.stringify(plan)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  return original.call(this, path, ...args);
};
require('node:module').syncBuiltinESMExports();\n`);
    const bounded = runWithEnv({ NODE_OPTIONS: `--require=${preload}` }, 'shard', '--plan', plan, '--index', '1',
      '--out', join(output, 'shard-1'), '--timeout-ms', '1500');
    expect(bounded.error).toBeUndefined();
    expect([124, 125]).toContain(bounded.status);
    expect(JSON.parse(bounded.stdout).outcome).toMatch(/timedOut|inconclusive/);
    expect(existsSync(join(output, 'shard-1'))).toBe(false);
  });
});
