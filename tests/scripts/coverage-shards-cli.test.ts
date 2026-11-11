import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('coverage-shard-cli-');
const command = resolve('scripts/coverage-shards.ts');

function waitForFile(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    const watcher = watch(resolve(path, '..'), { signal }, () => {
      if (existsSync(path)) {
        watcher.close();
        resolveWait();
      }
    });
    if (existsSync(path)) {
      watcher.close();
      resolveWait();
    }
  });
}

function fixture(runTimeoutMs = 30_000) {
  const cwd = tmp.make('repo');
  const output = tmp.make('artifacts');
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'tests'));
  mkdirSync(join(cwd, 'console'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module","scripts":{"guard:coverage-headroom":"node headroom.mjs"}}');
  writeFileSync(join(cwd, 'package-lock.json'), '{}');
  writeFileSync(join(cwd, 'console/package-lock.json'), '{}');
  writeFileSync(join(cwd, 'console/package.json'), '{"type":"module","scripts":{"coverage:check":"node check-coverage.mjs"}}');
  writeFileSync(join(cwd, 'console/check-coverage.mjs'), "import { accessSync } from 'node:fs';\nif (!process.argv.includes('--strict')) process.exit(42);\naccessSync('../coverage/coverage-summary.json');\n");
  writeFileSync(join(cwd, 'headroom.mjs'), "import { accessSync } from 'node:fs';\naccessSync('coverage/coverage-summary.json');\n");
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
  it('creates a requested coordinated output directory and refuses an existing one without overwriting it', () => {
    const { cwd, output, run } = fixture(30_000);
    const created = join(output, 'created-run-output');
    const completed = run('run', '--out', created, '--timeout-ms', '20000');
    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({ outcome: 'passed', exitCode: 0, operation: 'run' });
    expect(existsSync(join(created, 'plan.json'))).toBe(true);
    const existing = join(output, 'existing-run-output');
    mkdirSync(existing);
    const sentinel = join(existing, 'keep');
    writeFileSync(sentinel, 'unchanged');
    const refused = run('run', '--out', existing, '--timeout-ms', '20000');
    expect(refused.status, refused.stderr).toBe(125);
    expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: 'inconclusive', exitCode: 125, operation: 'run' });
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(existsSync(join(existing, 'plan.json'))).toBe(false);
  }, 30_000);

  it('runs two shards concurrently under one checkout lock before strict post-merge checks', async () => {
    const { cwd, output, run } = fixture(30_000);
    const artifacts = join(output, 'coordinated-output');
    const startedA = join(output, 'started-1');
    const startedB = join(output, 'started-2');
    const bothStarted = join(output, 'both-started');
    const release = join(output, 'release');
    writeFileSync(join(cwd, 'tests/a.test.ts'), `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { choose } from '../src/main.ts';
const startedA = ${JSON.stringify(startedA)};
const startedB = ${JSON.stringify(startedB)};
const bothStarted = ${JSON.stringify(bothStarted)};
const release = ${JSON.stringify(release)};
test('shard one waits for shard two before release', () => {
  writeFileSync(startedA, 'started');
  const deadline = Date.now() + 10_000;
  while (!existsSync(startedB) && Date.now() < deadline) {}
  if (!existsSync(startedB)) throw new Error('shard two never started');
  writeFileSync(bothStarted, readFileSync(startedB, 'utf8'));
  while (!existsSync(release) && Date.now() < deadline) {}
  if (!existsSync(release)) throw new Error('shard one was not released');
  expect(choose(true)).toBe(1);
});\n`);
    writeFileSync(join(cwd, 'tests/b.test.ts'), `import { existsSync, writeFileSync } from 'node:fs';
import { choose } from '../src/main.ts';
const startedA = ${JSON.stringify(startedA)};
const startedB = ${JSON.stringify(startedB)};
const release = ${JSON.stringify(release)};
test('shard two starts while shard one owns its test', () => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(startedA) && Date.now() < deadline) {}
  if (!existsSync(startedA)) throw new Error('shard one never started');
  writeFileSync(startedB, 'started');
  while (!existsSync(release) && Date.now() < deadline) {}
  if (!existsSync(release)) throw new Error('shard two was not released');
  expect(choose(false)).toBe(2);
});\n`);
    const observation = new AbortController();
    const bothShardsStarted = waitForFile(bothStarted, observation.signal);
    const coordinated = spawn(process.execPath, [command, 'run', '--out', artifacts, '--timeout-ms', '20000'], {
      cwd, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    coordinated.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    coordinated.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const terminal = new Promise<number | null>((resolveTerminal, reject) => {
      coordinated.once('error', reject);
      coordinated.once('close', resolveTerminal);
    });
    let terminalStatus: number | null;
    try {
      await Promise.race([
        bothShardsStarted,
        terminal.then((status) => Promise.reject(new Error(`coordinated run ended before both shards started: ${status}; ${Buffer.concat(stdout).toString('utf8')}`))),
      ]);
      expect(existsSync(bothStarted)).toBe(true);
      expect(readFileSync(bothStarted, 'utf8')).toBe('started');
      const blocked = run('plan', '--out', join(output, 'unrelated-plan.json'));
      expect(blocked.status, blocked.stderr).toBe(75);
      expect(JSON.parse(blocked.stdout)).toMatchObject({ outcome: 'busy', exitCode: 75 });
    } finally {
      observation.abort();
      writeFileSync(release, 'release');
      terminalStatus = await terminal;
    }
    expect(terminalStatus, `${Buffer.concat(stderr).toString('utf8')}\n${Buffer.concat(stdout).toString('utf8')}`).toBe(0);
    const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    expect(result).toMatchObject({ outcome: 'passed', exitCode: 0, operation: 'run', completeCoverage: true, consoleCoverage: 'strict-passed' });
    expect(result.cleanup).toMatchObject({ outcome: 'passed', wrappedExit: 0 });
    expect(JSON.parse(readFileSync(join(artifacts, 'plan.json'), 'utf8')).identity.workers).toBe(1);
  }, 35_000);

  it('holds the checkout lock through a shard receipt exception and gives inconclusive precedence after its sibling fails', async () => {
    const { cwd, output, plan, run } = fixture(30_000);
    const artifacts = join(output, 'coordinated-output');
    expect(run('plan', '--out', plan).status).toBe(0);
    const initialPlan = JSON.parse(readFileSync(plan, 'utf8'));
    unlinkSync(plan);
    const shardOneTest = initialPlan.shards[0].includes('tests/a.test.ts') ? 'a' : 'b';
    const siblingLive = join(output, 'sibling-live');
    const releaseSibling = join(output, 'release-sibling');
    const receiptFailure = join(output, 'receipt-failure');
    const waitForSibling = `import { existsSync, writeFileSync } from 'node:fs';
import { choose } from '../src/main.ts';
const siblingLive = ${JSON.stringify(siblingLive)};
test('waits for the sibling to remain live before completing', () => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(siblingLive) && Date.now() < deadline) {}
  if (!existsSync(siblingLive)) throw new Error('sibling never became live');
  expect(choose(true)).toBe(1);
});\n`;
    const liveThenFail = `import { existsSync, writeFileSync } from 'node:fs';
import { choose } from '../src/main.ts';
const siblingLive = ${JSON.stringify(siblingLive)};
const releaseSibling = ${JSON.stringify(releaseSibling)};
test('remains live until released, then reports a native failure', () => {
  writeFileSync(siblingLive, 'live');
  const deadline = Date.now() + 10_000;
  while (!existsSync(releaseSibling) && Date.now() < deadline) {}
  if (!existsSync(releaseSibling)) throw new Error('sibling was not released');
  expect(choose(false)).toBe(3);
});\n`;
    writeFileSync(join(cwd, 'tests/a.test.ts'), shardOneTest === 'a' ? waitForSibling : liveThenFail);
    writeFileSync(join(cwd, 'tests/b.test.ts'), shardOneTest === 'b' ? waitForSibling : liveThenFail);
    const preload = join(output, 'receipt-failure.cjs');
    writeFileSync(preload, `if ((process.argv[1] || '').endsWith('/coverage-shard-worker.ts')) {
  const fs = require('node:fs');
  const original = fs.writeFileSync;
  const receipt = ${JSON.stringify(join(realpathSync(output), 'coordinated-output', 'shard-1', 'receipt.json'))};
  const failure = ${JSON.stringify(receiptFailure)};
  fs.writeFileSync = function(path, ...args) {
    if (String(path) === receipt) {
      original.call(this, failure, 'receipt write failed');
      throw new Error('injected shard receipt failure');
    }
    return original.call(this, path, ...args);
  };
  require('node:module').syncBuiltinESMExports();
}\n`);
    const coordinated = spawn(process.execPath, [command, 'run', '--out', artifacts, '--timeout-ms', '20000'], {
      cwd, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_OPTIONS: `--require=${preload}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    coordinated.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    coordinated.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const terminal = new Promise<number | null>((resolveTerminal, reject) => {
      coordinated.once('error', reject);
      coordinated.once('close', resolveTerminal);
    });
    const observation = new AbortController();
    let terminalStatus: number | null;
    try {
      await Promise.race([
        waitForFile(receiptFailure, observation.signal),
        terminal.then((status) => Promise.reject(new Error(`coordinated run ended before the receipt failure: ${status}; ${Buffer.concat(stdout).toString('utf8')}`))),
      ]);
      expect(existsSync(siblingLive)).toBe(true);
      const blocked = run('plan', '--out', join(output, 'unrelated-plan.json'));
      expect(blocked.status, blocked.stderr).toBe(75);
      expect(JSON.parse(blocked.stdout)).toMatchObject({ outcome: 'busy', exitCode: 75 });
    } finally {
      observation.abort();
      if (!existsSync(releaseSibling)) writeFileSync(releaseSibling, 'release');
      terminalStatus = await terminal;
    }
    const diagnostics = `${Buffer.concat(stderr).toString('utf8')}\n${Buffer.concat(stdout).toString('utf8')}`;
    expect(terminalStatus, diagnostics).toBe(125);
    expect(JSON.parse(Buffer.concat(stdout).toString('utf8'))).toMatchObject({ outcome: 'inconclusive', exitCode: 125, operation: 'run', phase: 'shard' });
  }, 35_000);

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
    mkdirSync(join(cwd, 'console/src'));
    for (const [name, value] of [['a', 'true'], ['b', 'false']]) {
      writeFileSync(join(cwd, `console/src/${name}.ts`), `export const side = () => ${value};\n`);
      const test = join(cwd, `tests/${name}.test.ts`);
      writeFileSync(test, `import { side } from '../console/src/${name}.ts';\n`
        + readFileSync(test, 'utf8').replace(`choose(${value})`, 'choose(side())'));
    }
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
    expect(Object.keys(summary).filter((path) => path !== 'total').sort()).toEqual([
      join(cwd, 'console/src/a.ts'), join(cwd, 'console/src/b.ts'), join(cwd, 'src/main.ts'),
    ]);
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

  it('refuses merge after source, dependency or configuration changes without writing coverage', () => {
    const { cwd, plan, output, run } = fixture();
    expect(run('plan', '--out', plan, '--max-workers', '1').status).toBe(0);
    for (const index of ['1', '2']) {
      const shard = run('shard', '--plan', plan, '--index', index, '--out', join(output, `shard-${index}`), '--timeout-ms', '20000');
      expect(shard.status, shard.stderr).toBe(0);
    }
    for (const file of ['src/main.ts', 'package-lock.json', 'vitest.config.ts']) {
      const path = join(cwd, file);
      const original = readFileSync(path, 'utf8');
      writeFileSync(path, `${original}\n`);
      const merged = run('merge', '--plan', plan, '--receipts', output, '--timeout-ms', '20000');
      expect(merged.status, `${file}: ${merged.stderr}`).toBe(125);
      expect(JSON.parse(merged.stdout)).toMatchObject({
        outcome: 'inconclusive', operation: 'merge', error: expect.stringContaining('identity differs'),
      });
      expect(existsSync(join(cwd, 'coverage/coverage-final.json'))).toBe(false);
      writeFileSync(path, original);
    }
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
