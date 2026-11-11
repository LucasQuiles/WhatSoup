import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanGitEnv } from '../src/lib/git-env.ts';
import { acquireProcessLock, isProcessLockError, releaseProcessLock, type ProcessLockHandle } from '../src/lib/process-lock.ts';
import { isRecord } from '../src/lib/type-guards.ts';
import { runBoundedBattery } from './full-suite-battery.ts';
import { parseClosedOptions } from './lib/cli-args.ts';
import { balanceCoverageFiles, coveragePlanDigest, parseCoveragePlan, readCoverageArtifact, validateCoverageShards, type CoverageRunIdentity, type CoverageShardPlan, type CoverageShardReceipt } from './lib/coverage-shards.ts';
import { assertRepositoryInputUnchanged, captureRepositoryInputSnapshot } from './lib/source-mutation.ts';
import { executeTestCommands, parseTestCounts } from './test-affected.ts';
import { pushGateChildEnv } from './push-gate.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(toolRoot, 'node_modules/vitest/vitest.mjs');
const HELP = `Usage: npm run coverage:shards -- plan --out PLAN [--timings JSON] [--max-workers 2] [--timeout-ms 30000]
       npm run coverage:shards -- shard --plan PLAN --index 1|2 --out NEW_DIRECTORY [--timeout-ms 2700000]
       npm run coverage:shards -- merge --plan PLAN --receipts DIRECTORY [--timeout-ms 300000]
       npm run coverage:shards -- run [--out DIRECTORY] [--max-workers 2] [--timeout-ms 2700000]
Store shard outputs as DIRECTORY/shard-1 and DIRECTORY/shard-2. Artifacts must be
outside the checkout. The caller owns their retention and removal. Matching source,
runtime, platform and absolute checkout root are required. Only the complete native
merge enforces coverage thresholds. The coordinated run holds one checkout lock, runs
both isolated shards concurrently, then performs console strict coverage and headroom.
Compile caching is disabled. Forks and isolation remain enabled. JSON results go to stdout.
Exit: 0 passed, native nonzero failure, 2 invalid input, 75 busy, 124 timeout, 125 inconclusive.
`;

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const readJson = (path: string, maximumBytes = 256 * 1024 * 1024): unknown => JSON.parse(readCoverageArtifact(resolve(path), undefined, maximumBytes).toString('utf8'));
export interface CoverageCommandResult { exitCode: number; outcome?: string; operation?: string; error?: string; [key: string]: unknown }

function identity(cwd: string, executionId: string, workers: number, inputDigest: string): CoverageRunIdentity {
  return {
    executionId,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env: cleanGitEnv(), encoding: 'utf8', timeout: 10_000 }).trim(),
    inputDigest,
    dependencyDigest: sha(['package-lock.json', 'console/package-lock.json'].map((file) => `${file}:${sha(readCoverageArtifact(join(cwd, file), undefined, 8 * 1024 * 1024))}`).join('\n')),
    configDigest: sha(readCoverageArtifact(join(cwd, 'vitest.config.ts'), undefined, 1024 * 1024)),
    root: cwd, node: process.version,
    vitest: JSON.parse(readCoverageArtifact(join(toolRoot, 'node_modules/vitest/package.json'), undefined, 1024 * 1024).toString('utf8')).version,
    platform: process.platform as CoverageRunIdentity['platform'], arch: process.arch as CoverageRunIdentity['arch'], workers,
  };
}

function externalOutput(cwd: string, path: string): string {
  const absolute = resolve(path);
  const parent = realpathSync(dirname(absolute));
  const canonical = join(parent, absolute.slice(dirname(absolute).length + 1));
  const rel = relative(cwd, canonical);
  if (rel === '' || (!rel.startsWith('../') && !isAbsolute(rel))) throw new Error('Coverage artifacts must be outside the checkout');
  return canonical;
}

function timingDurations(path: string | undefined, root: string): Record<string, number> {
  if (!path) return {};
  const report = readJson(path);
  parseTestCounts(report);
  if (!isRecord(report) || !Array.isArray(report.testResults)) throw new Error('Invalid timing report');
  const seen = new Set<string>();
  return Object.fromEntries(report.testResults.map((row: unknown) => {
    if (!isRecord(row) || typeof row.name !== 'string' || typeof row.startTime !== 'number' || typeof row.endTime !== 'number'
      || !Number.isFinite(row.endTime - row.startTime) || row.endTime < row.startTime) throw new Error('Invalid test duration');
    const file = relative(root, row.name);
    if (!isAbsolute(row.name) || resolve(row.name) !== row.name || !file.startsWith('tests/')) {
      throw new Error('Timing report must use the same absolute checkout root');
    }
    if (seen.has(file)) throw new Error('Duplicate coverage timing name');
    seen.add(file);
    return [file, row.endTime - row.startTime];
  }));
}

function parseOptions(argv: readonly string[]) {
  const operation = argv[0];
  const fields = operation === 'plan' ? ['--out', '--timings', '--max-workers', '--timeout-ms']
    : operation === 'shard' ? ['--plan', '--index', '--out', '--timeout-ms']
      : operation === 'merge' ? ['--plan', '--receipts', '--timeout-ms']
        : operation === 'run' ? ['--out', '--max-workers', '--timeout-ms'] : [];
  const options = parseClosedOptions(argv.slice(1), { booleanOptions: [], valueOptions: fields });
  if (!fields.length || options.error) throw new Error(`Invalid coverage command: ${options.error ?? operation}`);
  const required = operation === 'plan' ? ['--out'] : operation === 'shard' ? ['--plan', '--index', '--out'] : operation === 'merge' ? ['--plan', '--receipts'] : [];
  if (required.some((field) => !options.values.has(field))) throw new Error(`Missing options: ${required.join(', ')}`);
  const totalWorkers = Number(options.values.get('--max-workers') ?? 2);
  const workers = operation === 'run' ? totalWorkers / 2 : totalWorkers;
  const timeoutMs = Number(options.values.get('--timeout-ms') ?? (operation === 'plan' ? 30_000 : operation === 'shard' || operation === 'run' ? 2_700_000 : 300_000));
  if (!Number.isInteger(workers) || workers < 1 || workers > 4 || operation === 'run' && totalWorkers > 4
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2_700_000) {
    throw new Error('Invalid worker count or timeout budget');
  }
  const index = Number(options.values.get('--index'));
  if (operation === 'shard' && index !== 1 && index !== 2) throw new Error('Shard index must be 1 or 2');
  return { operation, options, workers, totalWorkers: operation === 'run' ? totalWorkers : undefined, timeoutMs, index };
}

export async function runCoverageCommand(argv: readonly string[], cwd = realpathSync(process.cwd()), budgetMs?: number): Promise<CoverageCommandResult> {
  if (argv[0] === '--help') return { help: HELP, exitCode: 0 };
  const { operation, options, workers, totalWorkers, index, timeoutMs: requestedMs } = parseOptions(argv);
  const timeoutMs = budgetMs ?? requestedMs;
  const started = performance.now();
  const snapshot = captureRepositoryInputSnapshot({ cwd });
  const scratch = mkdtempSync(join(tmpdir(), 'whatsoup-coverage-'));
  const loadgatePath = join(homedir(), '.local/bin/loadgate');
  const admission = existsSync(loadgatePath) ? 'shared-host' : 'local-limits-only';
  const run = async (phase: 'plan' | 'shard' | 'merge', args: string[], env: NodeJS.ProcessEnv = {}, heldLock?: ProcessLockHandle) => executeTestCommands(cwd, [{ name: `coverage-${phase}`, command: process.execPath, args: [vitest, ...args] }], {
    // Reserve report validation and cleanup time inside the caller's outer budget.
    timeoutMs: Math.max(1, timeoutMs - (performance.now() - started) - Math.min(10_000, timeoutMs / 4)),
    json: true, loadgate: admission === 'shared-host' ? loadgatePath : undefined,
    env: { NODE_DISABLE_COMPILE_CACHE: '1', ...env }, heldLock,
    inheritOuterGroup: process.env.WHATSOUP_BOUNDED_BATTERY_OWNER_PID !== undefined,
  });
  const planCoverage = async (out: string, planWorkers: number, timings?: string, heldLock?: ProcessLockHandle): Promise<{ result: CoverageCommandResult; plan?: CoverageShardPlan }> => {
    const inventory = join(scratch, 'inventory.json');
    const result = await run('plan', ['list', '--root', cwd, '--config', join(cwd, 'vitest.config.ts'), '--filesOnly', '--json', inventory], {}, heldLock);
    if (result.exitCode !== 0) return { result: { schemaVersion: 1, operation: 'plan', admission, ...result } };
    const files = readJson(inventory, 8 * 1024 * 1024);
    if (!Array.isArray(files) || files.some((row) => !isRecord(row) || typeof row.file !== 'string' || row.projectName !== undefined)) {
      throw new Error('Native test inventory is invalid or uses unsupported projects');
    }
    const plan = parseCoveragePlan({ schemaVersion: 1, identity: identity(cwd, randomUUID(), planWorkers, snapshot.digest),
      shards: balanceCoverageFiles(files.map((row) => relative(cwd, row.file)), timingDurations(timings, cwd)) });
    writeFileSync(out, `${JSON.stringify(plan)}\n`, { flag: 'wx', mode: 0o600 });
    return { plan, result: { schemaVersion: 1, operation: 'plan', admission, outcome: 'passed', exitCode: 0, plan: out, planDigest: coveragePlanDigest(plan), files: files.length,
      durationBasis: timings === undefined ? 'equal-estimates' : 'measured' } };
  };
  const shardCoverage = async (planPath: string, plan: CoverageShardPlan, shardIndex: number, out: string, heldLock?: ProcessLockHandle): Promise<CoverageCommandResult> => {
    const observed = identity(cwd, plan.identity.executionId, plan.identity.workers, snapshot.digest);
    if (JSON.stringify(observed) !== JSON.stringify(plan.identity)) throw new Error('Coverage execution identity differs from the plan; reconcile before retrying');
    mkdirSync(out, { mode: 0o700 });
    const blobPath = join(out, 'blob.json');
    const reportPath = join(out, 'report.json');
    const shardConfig = join(scratch, `shard-${shardIndex}.config.mts`);
    writeFileSync(shardConfig, `import base from ${JSON.stringify(join(cwd, 'vitest.config.ts'))};\n`
      + `import { mergeConfig } from ${JSON.stringify(join(toolRoot, 'node_modules/vitest/dist/config.js'))};\n`
      + `import Sequencer from ${JSON.stringify(join(toolRoot, 'scripts/lib/coverage-shard-sequencer.ts'))};\n`
      + 'export default async (env) => mergeConfig(await (typeof base === "function" ? base(env) : base), { test: { sequence: { sequencer: Sequencer } } });\n');
    const result = await run('shard', ['run', '--root', cwd, '--config', shardConfig, '--pool=forks', '--isolate',
      `--maxWorkers=${plan.identity.workers}`, '--coverage', `--shard=${shardIndex}/2`,
      '--reporter=default', '--reporter=blob', '--reporter=json', `--outputFile.blob=${blobPath}`, `--outputFile.json=${reportPath}`,
      '--coverage.thresholds.lines=0', '--coverage.thresholds.branches=0', '--coverage.thresholds.functions=0', '--coverage.thresholds.statements=0',
      '--coverage.reporter=json', `--coverage.reportsDirectory=${join(scratch, `coverage-${shardIndex}`)}`], {
      WHATSOUP_COVERAGE_PLAN: planPath, WHATSOUP_COVERAGE_PLAN_DIGEST: coveragePlanDigest(plan),
    }, heldLock);
    if (result.exitCode !== 0) return { schemaVersion: 1, operation: 'shard', admission, ...result };
    assertRepositoryInputUnchanged({ cwd, snapshot, stage: 'coverage-shard', report: (message) => process.stderr.write(`${message}\n`) });
    const receipt: CoverageShardReceipt = { schemaVersion: 1, planDigest: coveragePlanDigest(plan), identity: observed, index: shardIndex,
      outcome: 'passed', exitCode: 0, blobPath, reportPath, blobSha256: sha(readCoverageArtifact(blobPath)), reportSha256: sha(readCoverageArtifact(reportPath)) };
    writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return { schemaVersion: 1, operation: 'shard', admission, ...result, receipt: join(out, 'receipt.json') };
  };
  const mergeCoverage = async (plan: CoverageShardPlan, directory: string, heldLock?: ProcessLockHandle): Promise<CoverageCommandResult> => {
    const observed = identity(cwd, plan.identity.executionId, plan.identity.workers, snapshot.digest);
    if (JSON.stringify(observed) !== JSON.stringify(plan.identity)) throw new Error('Coverage execution identity differs from the plan; reconcile before retrying');
    const receipts = readdirSync(directory).filter((name) => name.startsWith('shard-')).map((name) => {
      const shardDirectory = join(directory, name);
      if (!['shard-1', 'shard-2'].includes(name) || realpathSync(shardDirectory) !== shardDirectory) {
        throw new Error('Coverage shard directory differs from the selected artifact root');
      }
      const receipt = readJson(join(shardDirectory, 'receipt.json'), 64 * 1024);
      if (!isRecord(receipt) || receipt.index !== Number(name.slice('shard-'.length))
        || receipt.blobPath !== join(shardDirectory, 'blob.json') || receipt.reportPath !== join(shardDirectory, 'report.json')) {
        throw new Error('Coverage receipt artifact paths differ from the selected shard directory');
      }
      return receipt;
    });
    const validated = validateCoverageShards(plan, receipts);
    const blobs = join(scratch, 'blobs');
    mkdirSync(blobs);
    for (const [offset, path] of validated.blobPaths.entries()) {
      const receipt = receipts.find((row) => isRecord(row) && row.index === offset + 1) as CoverageShardReceipt;
      const bytes = readCoverageArtifact(path, receipt.blobSha256);
      writeFileSync(join(blobs, `blob-${offset + 1}.json`), bytes, { flag: 'wx' });
    }
    const result = await run('merge', ['run', '--root', cwd, '--config', join(cwd, 'vitest.config.ts'), `--merge-reports=${blobs}`, '--coverage',
      '--coverage.reporter=text', '--coverage.reporter=json', '--coverage.reporter=json-summary', '--coverage.reporter=lcovonly'], {}, heldLock);
    if (result.exitCode === 0) {
      const merged = readJson(join(cwd, 'coverage/coverage-final.json'));
      if (!isRecord(merged) || JSON.stringify(Object.keys(merged).sort()) !== JSON.stringify(validated.coverageFiles)) throw new Error('Merged coverage scope differs from admitted shards');
    }
    return { schemaVersion: 1, operation: 'merge', admission, ...result, tests: validated.tests };
  };
  const coordinatedRun = async (): Promise<CoverageCommandResult> => {
    const requestedOutput = options.values.get('--out');
    const artifacts = requestedOutput === undefined ? join(scratch, 'run-artifacts') : externalOutput(cwd, requestedOutput);
    const artifactReport = requestedOutput === undefined
      ? { ownership: 'worker-scratch', cleanup: 'included in worker cleanup' }
      : { ownership: 'caller', path: artifacts, cleanup: 'retained for debugging' };
    const lockPath = join(cwd, '.local/test-run.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    let lock: ProcessLockHandle;
    try { lock = acquireProcessLock(lockPath); }
    catch (error) {
      if (!isProcessLockError(error)) throw error;
      return { schemaVersion: 1, operation: 'run', admission, outcome: 'busy', exitCode: 75, artifacts: artifactReport,
        error: `${error.reason} test lock; owner PID ${error.existingPid ?? 'unknown'} at ${lockPath}. Inspect the owner before retrying; this run did not queue or remove the lock.` };
    }
    let coordinated: CoverageCommandResult | undefined;
    try {
      mkdirSync(artifacts, { mode: 0o700 });
      const planPath = join(artifacts, 'plan.json');
      const planned = await planCoverage(planPath, workers, undefined, lock);
      if (planned.result.exitCode !== 0 || planned.plan === undefined) {
        coordinated = { ...planned.result, operation: 'run', phase: 'plan', artifacts: artifactReport, workers: { total: totalWorkers, perShard: workers } };
      } else {
        const shardResults = await Promise.allSettled([1, 2].map((shardIndex) => shardCoverage(planPath, planned.plan!, shardIndex, join(artifacts, `shard-${shardIndex}`), lock)));
        const shards = shardResults.map((result) => result.status === 'fulfilled' ? result.value : {
          schemaVersion: 1, operation: 'shard', admission, outcome: 'inconclusive', exitCode: 125, error: String(result.reason),
        });
        const failedShard = shards.find((result) => result.exitCode === 125) ?? shards.find((result) => result.exitCode !== 0);
        if (failedShard) {
          coordinated = { ...failedShard, operation: 'run', phase: 'shard', artifacts: artifactReport, workers: { total: totalWorkers, perShard: workers }, plan: planPath, shards };
        } else {
          const merged = await mergeCoverage(planned.plan, artifacts, lock);
          if (merged.exitCode !== 0) {
            coordinated = { ...merged, operation: 'run', phase: 'merge', artifacts: artifactReport, workers: { total: totalWorkers, perShard: workers }, plan: planPath, shards };
          } else {
            const postMerge = await executeTestCommands(cwd, [
              { name: 'console-strict-coverage', command: 'npm', args: ['--prefix', 'console', 'run', 'coverage:check', '--', '--strict'] },
              { name: 'coverage-headroom', command: 'npm', args: ['run', 'guard:coverage-headroom'] },
            ], {
              timeoutMs: Math.max(1, timeoutMs - (performance.now() - started) - Math.min(10_000, timeoutMs / 4)), json: true,
              loadgate: admission === 'shared-host' ? loadgatePath : undefined, heldLock: lock,
              env: { NODE_DISABLE_COMPILE_CACHE: '1' }, inheritOuterGroup: process.env.WHATSOUP_BOUNDED_BATTERY_OWNER_PID !== undefined,
            });
            coordinated = postMerge.exitCode === 0
              ? { schemaVersion: 1, operation: 'run', admission, outcome: 'passed', exitCode: 0, artifacts: artifactReport,
                workers: { total: totalWorkers, perShard: workers }, plan: planPath, planDigest: coveragePlanDigest(planned.plan), shards, merge: merged, postMerge, consoleCoverage: 'strict-passed' }
              : { ...postMerge, operation: 'run', phase: 'post-merge', artifacts: artifactReport, workers: { total: totalWorkers, perShard: workers }, plan: planPath, shards, merge: merged };
          }
        }
      }
    } finally {
      try {
        if (!releaseProcessLock(lock!)) {
          coordinated = { ...coordinated!, nativeResultExit: coordinated?.exitCode, outcome: 'inconclusive', exitCode: 125,
            error: [coordinated?.error, 'test lock release failed: ownership changed or lock unavailable'].filter(Boolean).join('; ') };
        }
      } catch (error) {
        coordinated = { ...coordinated!, nativeResultExit: coordinated?.exitCode, outcome: 'inconclusive', exitCode: 125,
          error: [coordinated?.error, `test lock release failed: ${String(error)}`].filter(Boolean).join('; ') };
      }
    }
    return coordinated!;
  };
  const perform = async (): Promise<CoverageCommandResult> => {
    if (operation === 'plan') return (await planCoverage(externalOutput(cwd, options.values.get('--out')!), workers, options.values.get('--timings'))).result;
    if (operation === 'shard') {
      const planPath = resolve(options.values.get('--plan')!);
      const plan = parseCoveragePlan(readJson(planPath, 8 * 1024 * 1024));
      return shardCoverage(planPath, plan, index, externalOutput(cwd, options.values.get('--out')!));
    }
    if (operation === 'merge') {
      const plan = parseCoveragePlan(readJson(resolve(options.values.get('--plan')!), 8 * 1024 * 1024));
      return mergeCoverage(plan, realpathSync(options.values.get('--receipts')!));
    }
    return coordinatedRun();
  };
  let result: CoverageCommandResult;
  try { result = await perform(); }
  catch (error) { result = { schemaVersion: 1, operation, admission, outcome: 'inconclusive', exitCode: 125, error: String(error) }; }
  try { assertRepositoryInputUnchanged({ cwd, snapshot, stage: `coverage-${operation}`, report: (message) => process.stderr.write(`${message}\n`) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (result.exitCode === 0) {
      result.outcome = message.startsWith('FINAL-SOURCE drift:') ? 'failed' : 'inconclusive';
      result.exitCode = result.outcome === 'failed' ? 1 : 125;
    }
    result.error = [result.error, message].filter(Boolean).join('; ');
  }
  try { rmSync(scratch, { recursive: true, force: true }); }
  catch (error) { result = { ...result, outcome: 'inconclusive', exitCode: 125, error: `${result.error ?? ''}; scratch cleanup failed: ${String(error)}` }; }
  if (performance.now() - started >= timeoutMs && result.exitCode === 0) return { ...result, outcome: 'timedOut', exitCode: 124 };
  return result;
}

/** The existing process watchdog also owns synchronous snapshot, report and cleanup work. */
async function runBoundedCoverageCommand(argv: readonly string[]): Promise<CoverageCommandResult> {
  if (argv[0] === '--help') return { help: HELP, exitCode: 0 };
  const { operation, timeoutMs } = parseOptions(argv);
  const started = performance.now();
  const remaining = () => timeoutMs - (performance.now() - started);
  const cleanupReserve = Math.min(5000, timeoutMs / 4);
  const graceMs = Math.min(500, cleanupReserve / 4);
  const scratch = join(tmpdir(), `coverage-command-${randomUUID()}`);
  const inheritOuterGroup = process.env.WHATSOUP_BOUNDED_BATTERY_OWNER_PID !== undefined;
  let result: CoverageCommandResult = { schemaVersion: 1, operation, outcome: 'inconclusive', exitCode: 125 };
  let childReaped = true;
  try {
    const budgetMs = Math.max(1, remaining() - cleanupReserve - graceMs);
    const supervision = await runBoundedBattery({
      command: process.execPath,
      args: [join(toolRoot, 'scripts/lib/coverage-shard-worker.ts'), scratch, String(budgetMs), ...argv],
      cwd: process.cwd(), timeoutMs: budgetMs, graceMs, now: () => performance.now(), stdoutLimitBytes: 65_536, inheritOuterGroup,
      env: { ...pushGateChildEnv(), NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: scratch },
    });
    result = { ...result, supervision };
    childReaped = supervision.outcome !== 'inconclusive';
    if (supervision.timedOut || supervision.signal || supervision.outcome === 'inconclusive') {
      result.outcome = supervision.outcome;
      result.exitCode = supervision.wrappedExit;
    } else {
      const record: unknown = JSON.parse(supervision.stdout ?? 'null');
      if (!isRecord(record) || record.operation !== operation || record.exitCode !== supervision.wrappedExit
        || !(record.outcome === 'passed' && record.exitCode === 0
          || record.outcome === 'failed' && Number.isInteger(record.exitCode) && Number(record.exitCode) > 0 && Number(record.exitCode) <= 255
          || record.outcome === 'busy' && record.exitCode === 75
          || record.outcome === 'timedOut' && record.exitCode === 124
          || record.outcome === 'inconclusive' && record.exitCode === 125)) {
        throw new Error('Coverage worker did not produce a matching terminal result');
      }
      result = { ...record, exitCode: supervision.wrappedExit, supervision };
    }
  } catch (error) {
    result = { ...result, outcome: 'inconclusive', exitCode: 125, error: String(error) };
  } finally {
    // Run cleanup in the same bounded mechanism: a slow filesystem cannot hang the caller.
    const cleanupBudget = remaining() - graceMs;
    if (!childReaped) {
      result = { ...result, outcome: 'inconclusive', exitCode: 125, retainedScratch: scratch, error: 'Child cleanup is unverified; reconcile before removing scratch or retrying' };
    } else if (cleanupBudget > 0) {
      try {
        const cleanup = await runBoundedBattery({
          command: process.execPath,
          args: ['--input-type=module', '-e', 'import { rmSync } from "node:fs"; rmSync(process.argv[1], { recursive: true, force: true });', scratch],
          timeoutMs: cleanupBudget, graceMs, now: () => performance.now(), stdio: 'diagnostic', inheritOuterGroup,
          env: { ...pushGateChildEnv(), NODE_DISABLE_COMPILE_CACHE: '1' },
        });
        result.cleanup = cleanup;
        if (cleanup.wrappedExit !== 0) {
          result = { ...result, nativeResultExit: result.exitCode, outcome: 'inconclusive', exitCode: 125, retainedScratch: scratch };
        }
      } catch (error) {
        result = { ...result, nativeResultExit: result.exitCode, outcome: 'inconclusive', exitCode: 125, retainedScratch: scratch, error: String(error) };
      }
    } else {
      result = { ...result, nativeResultExit: result.exitCode, outcome: 'inconclusive', exitCode: 125, retainedScratch: scratch, error: 'Coverage cleanup budget exhausted' };
    }
  }
  if (remaining() <= 0 && result.exitCode === 0) result = { ...result, outcome: 'timedOut', exitCode: 124 };
  return { ...result, wallMs: performance.now() - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runBoundedCoverageCommand(process.argv.slice(2));
    process.stdout.write(typeof result.help === 'string' ? result.help : `${JSON.stringify({ ...result,
      scope: 'root-coverage', completeCoverage: ['merge', 'run'].includes(String(result.operation)) && result.outcome === 'passed',
      consoleCoverage: result.operation === 'run' ? result.consoleCoverage : 'not-run',
      omittedObligations: result.operation === 'run'
        ? ['static', 'behavioral', 'docker', 'python', 'other-platforms']
        : ['console-strict-report', 'static', 'behavioral', 'docker', 'python', 'other-platforms'],
    })}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalid = /^(Invalid coverage command|Missing options|Invalid worker count|Shard index)/.test(message);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, operation: process.argv[2], outcome: invalid ? 'invalid' : 'inconclusive', exitCode: invalid ? 2 : 125, error: message })}\n`);
    process.exitCode = invalid ? 2 : 125;
  }
}
