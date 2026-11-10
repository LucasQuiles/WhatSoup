import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTestCommands,
  executeTestCommands,
  executeTestCommandsWithRepositoryInputCheck,
  readTestCounts,
} from '../../scripts/test-affected.ts';
import { createTestPlan, parseTestOptions } from '../../scripts/test-plan.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('test-affected-');

function makeGitRepository(cwd: string): void {
  mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'main.ts'), 'export const main = true;\n');
  writeFileSync(join(cwd, 'src', 'lib', 'helper.ts'), 'export const helper = true;\n');
  execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
}

const completedReport = {
  success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
  numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }] }],
};

describe('affected test execution', () => {
  it('passes CI context without copying unrelated parent credentials to workers', async () => {
    const cwd = tmp.make('environment');
    const observation = join(cwd, 'environment.json');
    vi.stubEnv('UNRELATED_TEST_SECRET', 'must-stay-in-parent');
    vi.stubEnv('CI', 'true');
    try {
      const result = await executeTestCommands(cwd, [{
        name: 'environment', command: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({ci:process.env.CI,inherited:process.env.UNRELATED_TEST_SECRET!==undefined}))', observation],
      }], { timeoutMs: 10_000, json: false });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({ ci: 'true', inherited: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { ...completedReport, success: false },
    { ...completedReport, numTotalTests: 8 },
    { ...completedReport, testResults: [] },
    { ...completedReport, testResults: [{ status: 'passed', assertionResults: [{ status: 'pending' }] }] },
  ])('rejects a falsely successful or incomplete report: %j', (report) => {
    const file = join(tmp.make('report'), 'results.json');
    writeFileSync(file, JSON.stringify(report));
    expect(() => readTestCounts(file)).toThrow();
  });

  it('reports deliberate skips while retaining a real passed case', () => {
    const file = join(tmp.make('skips'), 'results.json');
    writeFileSync(file, JSON.stringify({ ...completedReport, numTotalTests: 2, numPendingTests: 1,
      testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'skipped' }] }],
    }));
    expect(readTestCounts(file)).toEqual({ files: 1, total: 2, passed: 1, failed: 0, pending: 1, todo: 0 });
  });
  it('plans no application suite for docs and keeps coverage complete', () => {
    const options = parseTestOptions(['--files', 'README.md']);
    const plan = createTestPlan(process.cwd(), options);
    expect(buildTestCommands(process.cwd(), plan)).toEqual([]);
    const coverage = createTestPlan(process.cwd(), parseTestOptions(['--full', '--coverage', '--suite', 'root']));
    const commands = buildTestCommands(process.cwd(), coverage);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toContain('scripts/run-coverage-check.sh');
    expect(commands[0]?.args).not.toContain('related');
  });

  it('reuses the release manifest without repeating its guard package suite', () => {
    const plan = createTestPlan(process.cwd(), parseTestOptions(['--full']));
    const commands = buildTestCommands(process.cwd(), plan);
    expect(commands.map(({ name }) => name)).toEqual(['release-validation']);
  });

  it('includes curated sentinel checks before the Python suite that excludes them', () => {
    const plan = createTestPlan(process.cwd(), parseTestOptions(['--full', '--suite', 'python']));
    expect(buildTestCommands(process.cwd(), plan).map(({ args }) => args)).toEqual([
      ['deploy/scripts/run-sentinel-tests.sh'],
      ['deploy/scripts/run-bot-errors-full-suite.sh'],
    ]);
  });

  it('stops after a real child failure, preserves exit, and removes its scratch', async () => {
    const cwd = tmp.make('failure');
    const marker = join(cwd, 'scratch-location');
    const sentinel = join(cwd, 'must-not-run');
    const report = await executeTestCommands(cwd, [
      { name: 'failing', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.env.TMPDIR);process.exit(7)', marker] },
      { name: 'later', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', sentinel] },
    ], { timeoutMs: 10_000, json: false });
    expect(report).toMatchObject({ outcome: 'failed', exitCode: 7 });
    expect(report.results).toHaveLength(1);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(readFileSync(marker, 'utf8'))).toBe(false);
    expect(existsSync(join(cwd, '.local/test-run.lock'))).toBe(false);
  });

  it.each([[75, 'busy'], [124, 'timedOut'], [125, 'inconclusive']] as const)(
    'preserves the protocol meaning of nested exit %s', async (exitCode, outcome) => {
      const cwd = tmp.make('nested-outcome');
      const sentinel = join(cwd, 'must-not-run');
      const report = await executeTestCommands(cwd, [
        { name: 'nested-gate', command: process.execPath, args: ['-e', `process.exit(${exitCode})`] },
        { name: 'later', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', sentinel] },
      ], { timeoutMs: 10_000, json: false });
      expect(report).toMatchObject({ outcome, exitCode });
      expect(report.results).toHaveLength(1);
      expect(report.results[0]).toMatchObject({ name: 'nested-gate', exitCode, signal: null });
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(cwd, '.local/test-run.lock'))).toBe(false);
    },
  );

  it('turns a persistent non-main source mutation into a failed selected-lane result', async () => {
    const cwd = tmp.make('source-drift');
    makeGitRepository(cwd);
    const report = await executeTestCommandsWithRepositoryInputCheck(cwd, [
      {
        name: 'mutator',
        command: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync("src/lib/helper.ts", "export const helper = false;\\n")'],
      },
    ], { timeoutMs: 10_000, json: false });

    expect(report).toMatchObject({ outcome: 'failed', exitCode: 1 });
    expect(report.error).toContain('FINAL-SOURCE drift: stage=test-affected changed=src/lib/helper.ts');
  });

  it('preserves the original child failure when source also drifts', async () => {
    const cwd = tmp.make('source-drift-failure');
    makeGitRepository(cwd);
    const report = await executeTestCommandsWithRepositoryInputCheck(cwd, [{
      name: 'failed-mutator', command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync("src/lib/helper.ts", "changed"); process.exit(7)'],
    }], { timeoutMs: 10_000, json: false });
    expect(report).toMatchObject({ outcome: 'failed', exitCode: 7 });
    expect(report.error).toContain('FINAL-SOURCE drift:');
  });

  it('reports unavailable final source evidence as inconclusive', async () => {
    const cwd = tmp.make('source-unavailable');
    makeGitRepository(cwd);
    const report = await executeTestCommandsWithRepositoryInputCheck(cwd, [{
      name: 'unavailable-git', command: process.execPath,
      args: ['-e', 'require("node:fs").renameSync(".git", ".git-off")'],
    }], { timeoutMs: 10_000, json: false });
    expect(report).toMatchObject({ outcome: 'inconclusive', exitCode: 125 });
    expect(report.error).toContain('FINAL-SOURCE cannot enumerate repository inputs');
  });

  it('refuses duplicate work immediately and retains the existing owner lock', async () => {
    const cwd = tmp.make('locked');
    const lock = acquireProcessLock(join(cwd, 'test.lock'));
    const marker = join(cwd, 'must-not-run');
    try {
      const report = await executeTestCommands(cwd, [
        { name: 'unused', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', marker] },
      ], { timeoutMs: 10_000, json: false, lockPath: lock.path });
      expect(report).toMatchObject({ outcome: 'busy', exitCode: 75, results: [] });
      expect(report.error).toContain(String(process.pid));
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(lock.path, 'utf8')).token).toBe(lock.token);
    } finally {
      releaseProcessLock(lock);
    }
  });

  it('bounds a hung child and reports timeout instead of a pass', async () => {
    const report = await executeTestCommands(tmp.make('timeout'), [
      { name: 'hung', command: process.execPath, args: ['-e', 'require("node:net").createServer(()=>{}).listen(0,"127.0.0.1")'] },
    ], { timeoutMs: 150, json: false });
    expect(report).toMatchObject({ outcome: 'timedOut', exitCode: 124 });
    expect(report.results[0]?.outcome).toBe('timedOut');
  });

  it('preserves scratch cleanup on an invalid child executable', async () => {
    const cwd = tmp.make('spawn');
    writeFileSync(join(cwd, 'untouched'), 'keep');
    const report = await executeTestCommands(cwd, [{ name: 'missing', command: join(cwd, 'missing'), args: [] }], { timeoutMs: 1000, json: false });
    expect(report.exitCode).not.toBe(0);
    expect(readFileSync(join(cwd, 'untouched'), 'utf8')).toBe('keep');
    expect(existsSync(join(cwd, '.local/test-run.lock'))).toBe(false);
  });

  it('does not call an empty or missing test report successful', async () => {
    const cwd = tmp.make('empty-report');
    const report = await executeTestCommands(cwd, [
      { name: 'false-green', command: process.execPath, args: ['-e', 'process.exit(0)', '--'], vitestReport: true },
    ], { timeoutMs: 1000, json: false });
    expect(report).toMatchObject({ outcome: 'inconclusive', exitCode: 125 });
    expect(report.error).toMatch(/ENOENT/);
  });

  it('distinguishes invalid CLI input from unavailable planning evidence', () => {
    const invalid = spawnSync(process.execPath, ['scripts/test-affected.ts', '--unknown', '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(invalid.status, invalid.stderr).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ outcome: 'invalid', exitCode: 2 });
    const missingBase = spawnSync(process.execPath, ['scripts/test-affected.ts', '--base', 'refs/heads/missing-test-base', '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(missingBase.status, missingBase.stderr).toBe(125);
    expect(JSON.parse(missingBase.stdout)).toMatchObject({ outcome: 'inconclusive', exitCode: 125 });
  });

  it.each([0, 7])('retains child exit %i and releases the lock when scratch removal fails', async (childExit) => {
    const cwd = tmp.make('cleanup-error');
    let ownedScratch: string | undefined;
    try {
      const result = await executeTestCommands(cwd, [
        { name: 'finished-child', command: process.execPath, args: ['-e', `process.exit(${childExit})`] },
      ], { timeoutMs: 10_000, json: false, cleanupScratch: (directory: string) => {
        ownedScratch = directory;
        throw new Error('cleanup denied');
      } });
      expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 125 });
      expect(result.error).toContain('scratch cleanup failed: Error: cleanup denied');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        name: 'finished-child', exitCode: childExit, wrappedExit: childExit,
        outcome: childExit === 0 ? 'passed' : 'failed',
      });
      expect(existsSync(join(cwd, '.local/test-run.lock'))).toBe(false);
    } finally {
      if (ownedScratch) rmSync(ownedScratch, { recursive: true, force: true });
    }
  });
});
