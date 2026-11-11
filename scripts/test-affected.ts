import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { acquireProcessLock, isProcessLockError, releaseProcessLock } from '../src/lib/process-lock.ts';
import { isRecord } from '../src/lib/type-guards.ts';
import { runBoundedBattery, type BoundedBatteryResult } from './full-suite-battery.ts';
import { functionalSuites } from './required-suites.ts';
import { pushGateChildEnv } from './push-gate.ts';
import {
  assertRepositoryInputUnchanged,
  captureRepositoryInputSnapshot,
  establishSourceMutationAnchor,
} from './lib/source-mutation.ts';
import { createTestPlan, parseTestOptions, TEST_HELP, type TestOptions, type TestPlan } from './test-plan.ts';

export interface TestCommand { name: string; command: string; args: string[]; cwd?: string; vitestReport?: boolean }
export interface TestCounts { files: number; total: number; passed: number; failed: number; pending: number; todo: number }
export interface TestExecution {
  outcome: BoundedBatteryResult['outcome'] | 'busy' | 'not-required';
  exitCode: number;
  wallMs: number;
  results: Array<BoundedBatteryResult & { name: string; tests?: TestCounts }>;
  error?: string;
}

export function buildTestCommands(cwd: string, plan: TestPlan): TestCommand[] {
  if (plan.profile === 'docs') return [];
  const commands: TestCommand[] = [];
  const node = (name: string, args: string[]): void => { commands.push({ name, command: process.execPath, args, vitestReport: args[0] === 'node_modules/vitest/vitest.mjs' }); };
  const npm = (name: string, args: string[]): void => { commands.push({ name, command: 'npm', args }); };
  const selected = (lane: keyof TestPlan['lanes']): boolean => plan.suite === 'all' ? plan.lanes[lane] : plan.suite === lane;
  const workerArg = `--maxWorkers=${plan.maxWorkers}`;
  if (plan.profile === 'full' && plan.suite === 'all') {
    node('release-validation', ['scripts/push-gate.ts', 'release']);
    // The existing release manifest already installs, typechecks and tests guard.
    return commands;
  } else {
    if (selected('root')) {
      if (plan.coverage) commands.push({ name: 'root-coverage', command: 'bash', args: ['scripts/run-coverage-check.sh', workerArg] });
      else if (plan.profile === 'full') node('root', ['node_modules/vitest/vitest.mjs', 'run', '--pool=forks', workerArg]);
      else {
        // Keep the established text-reference companions for readFile/CLI consumers;
        // Vitest adds transitive static and literal dynamic imports to this union.
        const companions = functionalSuites(cwd, plan.changedFiles)
          .filter((file) => !file.startsWith('tests/browser/') && !file.startsWith('tests/browser-motion/'));
        const related = [...new Set([...plan.changedFiles, ...companions])];
        node('root-affected', ['node_modules/vitest/vitest.mjs', 'related', '--run', '--pool=forks', workerArg, ...related]);
      }
    }
    if (selected('console')) {
      npm('console-lint', ['--prefix', 'console', 'run', 'lint']);
      npm('console-build', ['--prefix', 'console', 'run', 'build']);
      npm('console-design', ['run', 'verify:console-design:live']);
    }
    if (selected('browser')) {
      node('browser', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.browser.config.ts', '--maxWorkers=1']);
      node('browser-motion', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.browser.motion.config.ts', '--maxWorkers=1']);
    }
    if (selected('python')) {
      commands.push({ name: 'python-sentinel', command: 'bash', args: ['deploy/scripts/run-sentinel-tests.sh'] });
      commands.push({ name: 'python', command: 'bash', args: ['deploy/scripts/run-bot-errors-full-suite.sh'] });
    }
  }
  if (selected('guard')) {
    npm('guard-typecheck', ['--prefix', 'tools/whatsoup_guard', 'run', 'typecheck']);
    npm('guard-tests', ['--prefix', 'tools/whatsoup_guard', 'test', '--', workerArg]);
  }
  return commands;
}

export function readTestCounts(reportPath: string): TestCounts {
  return parseTestCounts(JSON.parse(readFileSync(reportPath, 'utf8')));
}

export function parseTestCounts(report: unknown): TestCounts {
  const fields = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'] as const;
  if (!isRecord(report) || report.success !== true || report.numFailedTestSuites !== 0 || report.numPendingTestSuites !== 0
    || !Array.isArray(report.testResults) || report.testResults.length === 0
    || !fields.every((field) => Number.isSafeInteger(report[field]) && Number(report[field]) >= 0)) {
    throw new Error('Vitest report is incomplete; test counts are unknown');
  }
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const file of report.testResults) {
    if (!isRecord(file) || file.status !== 'passed' || !Array.isArray(file.assertionResults) || file.assertionResults.length === 0) throw new Error('Incomplete Vitest file result');
    for (const row of file.assertionResults) {
      if (!isRecord(row) || !['passed', 'failed', 'skipped', 'todo'].includes(String(row.status))) throw new Error('Incomplete Vitest test result');
      counts[row.status as keyof typeof counts]++;
    }
  }
  if (counts.passed !== report.numPassedTests || counts.failed !== report.numFailedTests
    || counts.skipped !== report.numPendingTests || counts.todo !== report.numTodoTests
    || Object.values(counts).reduce((sum, count) => sum + count, 0) !== report.numTotalTests) throw new Error('Vitest report counts do not reconcile with its test results');
  return { files: report.testResults.length, total: Number(report.numTotalTests), passed: counts.passed, failed: counts.failed, pending: counts.skipped, todo: counts.todo };
}

export async function executeTestCommands(
  cwd: string,
  commands: readonly TestCommand[],
  options: { timeoutMs: number; json: boolean; lockPath?: string; loadgate?: string; env?: NodeJS.ProcessEnv; cleanupScratch?: (directory: string) => void; inheritOuterGroup?: boolean },
): Promise<TestExecution> {
  const clock = () => performance.now();
  const start = clock();
  const results: TestExecution['results'] = [];
  if (!commands.length) return { outcome: 'not-required', exitCode: 0, wallMs: 0, results };
  const lockPath = options.lockPath ?? join(cwd, '.local/test-run.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  let lock;
  try { lock = acquireProcessLock(lockPath); }
  catch (error) {
    if (!isProcessLockError(error)) throw error;
    return { outcome: 'busy', exitCode: 75, wallMs: clock() - start, results, error: `${error.reason} test lock; owner PID ${error.existingPid ?? 'unknown'} at ${lockPath}. Inspect the owner before retrying; this run did not queue or remove the lock.` };
  }
  let scratch: string | undefined;
  let execution: TestExecution | undefined;
  const complete = (outcome: TestExecution['outcome'], exitCode: number, error?: string): TestExecution => {
    execution = { outcome, exitCode, wallMs: clock() - start, results, error };
    return execution;
  };
  try {
    scratch = mkdtempSync(join(tmpdir(), 'whatsoup-tests-'));
    const env = {
      ...pushGateChildEnv(),
      CI: process.env.CI,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      ...options.env,
      TMPDIR: scratch,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    };
    for (const step of commands) {
      const remaining = options.timeoutMs - (clock() - start);
      if (remaining <= 0) return complete('timedOut', 124);
      process.stderr.write(`test:affected: ${step.name} (remaining ${remaining}ms)\n`);
      const reportPath = join(scratch, `vitest-${results.length}.json`);
      const args = step.vitestReport ? [...step.args, '--silent=passed-only', options.json ? '--reporter=dot' : '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`] : step.args;
      const admission = options.loadgate ? [
        '--strict', '--max-wait', String(Math.min(30, Math.max(1, Math.floor(remaining / 1000)))), '--label', 'whatsoup-tests', '--', step.command, ...args,
      ] : null;
      let result: BoundedBatteryResult;
      try {
        result = await runBoundedBattery({
          command: options.loadgate ?? step.command,
          args: admission ?? args,
          cwd: step.cwd ?? cwd, env, timeoutMs: remaining,
          now: clock,
          stdio: options.json ? 'diagnostic' : 'inherit',
          inheritOuterGroup: options.inheritOuterGroup,
        });
      } catch (error) {
        return complete('inconclusive', 125, `${step.name}: ${String(error)}`);
      }
      results.push({ name: step.name, ...result });
      if (result.wrappedExit !== 0) {
        let outcome: TestExecution['outcome'] = result.outcome;
        if (result.wrappedExit === 75) outcome = 'busy';
        else if (result.wrappedExit === 124) outcome = 'timedOut';
        else if (result.wrappedExit === 125) outcome = 'inconclusive';
        return complete(outcome, result.wrappedExit);
      }
      if (step.vitestReport) {
        try {
          const tests = readTestCounts(reportPath);
          results[results.length - 1]!.tests = tests;
          if (tests.passed === 0 || tests.failed > 0) throw new Error('No passing tests or failed tests in a successful runner report');
        } catch (error) {
          return complete('inconclusive', 125, String(error));
        }
      }
    }
    return complete('passed', 0);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      if (scratch) {
        if (options.cleanupScratch) options.cleanupScratch(scratch);
        else rmSync(scratch, { recursive: true, force: true });
      }
    } catch (error) {
      cleanupErrors.push(`scratch cleanup failed: ${String(error)}`);
    }
    try {
      if (!releaseProcessLock(lock)) cleanupErrors.push('test lock release failed: ownership changed or lock unavailable');
    } catch (error) {
      cleanupErrors.push(`test lock release failed: ${String(error)}`);
    }
    if (execution) {
      execution.wallMs = clock() - start;
      if (cleanupErrors.length) {
        // Retain child evidence even when cleanup or ownership cannot be established.
        execution.outcome = 'inconclusive';
        execution.exitCode = 125;
        execution.error = [execution.error, ...cleanupErrors].filter(Boolean).join('; ');
      }
    } else if (cleanupErrors.length) {
      throw new Error(cleanupErrors.join('; '));
    }
  }
}

/**
 * Keep the selected-lane result tied to the repository inputs present before its first child.
 * This outer check complements, rather than replaces, the root Vitest per-test tripwire.
 */
export async function executeTestCommandsWithRepositoryInputCheck(
  cwd: string,
  commands: readonly TestCommand[],
  options: Parameters<typeof executeTestCommands>[2],
): Promise<TestExecution> {
  const snapshot = captureRepositoryInputSnapshot({ cwd });
  let execution: TestExecution;
  try {
    execution = await executeTestCommands(cwd, commands, options);
  } catch (error) {
    assertRepositoryInputUnchanged({
      cwd,
      snapshot,
      stage: 'test-affected',
      report: (message) => process.stderr.write(`test:affected: ${message}\n`),
    });
    throw error;
  }
  try {
    assertRepositoryInputUnchanged({
      cwd,
      snapshot,
      stage: 'test-affected',
      report: (message) => process.stderr.write(`test:affected: ${message}\n`),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const drift = message.startsWith('FINAL-SOURCE drift:');
    return {
      ...execution,
      outcome: execution.exitCode !== 0 ? execution.outcome : drift ? 'failed' : 'inconclusive',
      exitCode: execution.exitCode || (drift ? 1 : 125),
      error: message,
    };
  }
  return execution;
}

async function main(options: TestOptions): Promise<void> {
  if (options.help) { process.stdout.write(TEST_HELP); return; }
  const cwd = process.cwd();
  const plan = createTestPlan(cwd, options);
  const commands = buildTestCommands(cwd, plan);
  const loadgatePath = join(homedir(), '.local/bin/loadgate');
  const loadgate = existsSync(loadgatePath) ? loadgatePath : undefined;
  const env: NodeJS.ProcessEnv = { VITEST_MAX_WORKERS: String(plan.maxWorkers) };
  if (commands.length) env.WHATSOUP_TRIPWIRE_MAIN_SHA256 = establishSourceMutationAnchor({ cwd, suppliedAnchor: process.env.WHATSOUP_TRIPWIRE_MAIN_SHA256 });
  const executionOptions = {
    timeoutMs: plan.timeoutMs, json: options.json, loadgate, env,
    inheritOuterGroup: process.env.WHATSOUP_BOUNDED_BATTERY_OWNER_PID !== undefined,
  };
  const result = commands.length
    ? await executeTestCommandsWithRepositoryInputCheck(cwd, commands, executionOptions)
    : await executeTestCommands(cwd, commands, executionOptions);
  const report = {
    schemaVersion: 1, ...result, plan,
    scope: plan.suite === 'all' ? 'selected-lanes' : 'focused-lane',
    omittedLanes: Object.entries(plan.lanes).filter(([name, selected]) => selected && plan.suite !== 'all' && name !== plan.suite).map(([name]) => name),
    admission: loadgate ? 'shared-host' : 'local-limits-only',
    ciObligations: ['compatibility', 'docker', ...(plan.suite === 'all' ? ['python'] : [])]
      .filter((lane) => plan.lanes[lane as keyof TestPlan['lanes']]),
    commands: commands.map(({ name, command, args }) => ({ name, command, args })),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(`test:affected: ${result.outcome}; ${result.wallMs}ms; ${result.results.length}/${commands.length} commands; scope=${report.scope}; exit=${result.exitCode}\n${result.error ? `${result.error}\n` : ''}`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reportError = (error: unknown, outcome: 'invalid' | 'inconclusive', exitCode: number): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, outcome, exitCode, error: message })}\n`);
    else process.stderr.write(`test:affected: ${message}\n`);
    process.exitCode = exitCode;
  };
  try {
    const options = parseTestOptions(process.argv.slice(2));
    main(options).catch((error: unknown) => reportError(error, 'inconclusive', 125));
  } catch (error) {
    reportError(error, 'invalid', 2);
  }
}
