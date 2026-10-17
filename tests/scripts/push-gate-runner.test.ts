/**
 * Caller propagation for the bounded gate runner:
 * the codes the battery/step produce must actually reach the OUTER invocation, and an
 * external signal must stop the run without starting a later stage.
 *
 * Covered here (the gap; runGate/stepTimeoutMs/gateLifetimeMs had no test at all):
 *   - normal path           -> 0
 *   - timeout               -> 124, later stage NOT run
 *   - unresolved reap       -> 125, later stage NOT run
 *   - external SIGTERM      -> 128+n, later stage NOT run
 *   - derived bound         -> valid override honored; invalid override falls back
 *   - outer invocation      -> the battery CLI REFUSES an invalid override (EX_USAGE, no run)
 *
 * Real child processes: a fake timer cannot bound an external process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { gateLifetimeMs, runGate, stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS, STEP_SETTLE_MS, STEP_TERM_GRACE_MS, type GateStep } from '../../scripts/push-gate.ts';
import { probeGroupMembership } from '../../scripts/full-suite-battery.ts';
import { gateCommandTimeoutMs } from '../../scripts/pre-push-guard.ts';
import { deferred } from '../helpers/deferred.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const NODE = process.execPath;
const ROOT = realpathSync(join(__dirname, '..', '..'));
const BATTERY = join(ROOT, 'scripts', 'full-suite-battery.ts');
const tmp = trackTmpDirs('gate-propagate-', { base: realpathSync(tmpdir()) });

function fixture(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const HANG = 'require("node:net").createServer(function(){}).listen(0,"127.0.0.1");';
// The hanging step announces its own pid immediately, then hangs. It writes the ready
// line only when argv[3] is given, so one fixture serves the announced case and the
// never-announced case, and both leave the pid the settlement needs.
const ANNOUNCING_HANG = [
  'const fs = require("node:fs");',
  'fs.writeFileSync(process.argv[2], "started " + process.pid + "\\n");',
  'require("node:net").createServer(function(){}).listen(0, "127.0.0.1", function () {',
  '  if (process.argv[3]) fs.appendFileSync(process.argv[2], "ready\\n");',
  '});',
].join('\n');
const MARKER = 'require("node:fs").writeFileSync(process.argv[2],"ran");';

/**
 * Readiness for a fixture step, with a terminal on every path. The fixture
 * announces itself by writing `path`; this waits for the ready line, for the
 * child to exit first, or for the deadline — whichever arrives first — and never
 * leaves a path without an answer. The directory watcher is registered before
 * the first existence check, so a write between the check and the registration
 * cannot be missed. The caller must run `close()` in a finally.
 */
const READINESS_DEADLINE_MS = 10_000;

type Readiness =
  | { state: 'ready' }
  | { state: 'exited'; code: number | null }
  | { state: 'deadline' };

function announcePath(dir: string, name: string): string {
  return join(dir, name);
}

function markerText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function waitForReadiness(
  path: string,
  deadlineMs: number,
  exited: Promise<number | null>,
): { outcome: Promise<Readiness>; close: () => void } {
  const result = deferred<Readiness>();
  let watcher: FSWatcher | undefined;
  let finished = false;
  const settleIfReady = (): void => {
    if (markerText(path).includes('ready')) finish({ state: 'ready' });
  };
  const finish = (outcome: Readiness): void => {
    if (finished) return;
    finished = true;
    watcher?.close();
    result.resolve(outcome);
  };

  watcher = watch(dirname(path), settleIfReady);
  settleIfReady();
  AbortSignal.timeout(deadlineMs).addEventListener('abort', () => finish({ state: 'deadline' }), { once: true });
  void exited.then((code) => finish({ state: 'exited', code }));

  return { outcome: result.promise, close: (): void => finish({ state: 'deadline' }) };
}

/** The pid the fixture announced, if it got as far as announcing. */
function announcedPid(path: string): number | undefined {
  const match = /started (\d+)/.exec(markerText(path));
  return match === null ? undefined : Number(match[1]);
}

/**
 * Kill one owned process group and report only whether it is gone, reusing the
 * battery's own rule: a negative pid targets the group, `ESRCH` means there is
 * nothing left to kill, and any other error is left to the caller's probe rather
 * than swallowed.
 */
function killOwnedGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * Prove a group has no live member, using the same `ps` membership read the
 * battery's reaper uses. Bounded in turns with event-loop yields, never by a
 * wall clock.
 */
async function groupIsGone(pgid: number, maxTurns = 2_000): Promise<boolean> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (probeGroupMembership(pgid) === 'no-live-members') return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return probeGroupMembership(pgid) === 'no-live-members';
}

/**
 * Settlement for everything this test caused: the runner and, separately, the
 * step the gate runner spawns DETACHED into its own group. Killing the runner
 * alone would leave that group alive, which is the reason this walks both.
 * Returns the proof, not a claim: each group is reported gone only when the
 * membership probe says it has no live member.
 */
async function settleOwnedForest(
  runner: ChildProcess,
  markerPath: string,
): Promise<{ runnerGone: boolean; stepGone: boolean }> {
  const stepPid = announcedPid(markerPath);
  if (stepPid !== undefined) killOwnedGroup(stepPid);
  if (runner.pid !== undefined) killOwnedGroup(runner.pid);
  if (runner.exitCode === null && runner.signalCode === null) {
    await new Promise<void>((resolve) => runner.once('exit', () => resolve()));
  }
  return {
    runnerGone: runner.pid === undefined ? true : await groupIsGone(runner.pid),
    stepGone: stepPid === undefined ? true : await groupIsGone(stepPid),
  };
}

const NO_CLOSE = [
  'const cp=require("node:child_process");',
  'const gc=cp.spawn(process.execPath,["-e","Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12000)"],{detached:true,stdio:"inherit"});',
  'gc.unref();',
  HANG,
].join('\n');

describe('runGate caller propagation (exit codes reach the outer invocation)', () => {
  it('normal path: every step passes -> 0', async () => {
    const dir = tmp.make('ok');
    const ok = fixture(dir, 'ok.cjs', 'process.exit(0);');
    const code = await runGate('test-lane', [
      { name: 'first', cmd: `${NODE} ${ok}` },
      { name: 'second', cmd: `${NODE} ${ok}` },
    ], { stdio: 'ignore' });
    expect(code).toBe(0);
  }, 30_000);

  it('timeout -> 124 and NO later stage runs', async () => {
    const dir = tmp.make('timeout');
    const hang = fixture(dir, 'hang.cjs', HANG);
    const marker = join(dir, 'later-ran');
    const later = fixture(dir, 'marker.cjs', MARKER);
    const code = await runGate('test-lane', [
      { name: 'hangs', cmd: `${NODE} ${hang}` },
      { name: 'later', cmd: `${NODE} ${later} ${marker}` },
    ], { stdio: 'ignore', timeoutMsFor: () => 300, termGraceMs: 200 });
    expect(code).toBe(124);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('unresolved reap -> 125 and NO later stage runs', async () => {
    const dir = tmp.make('unresolved');
    const noClose = fixture(dir, 'no-close.cjs', NO_CLOSE);
    const marker = join(dir, 'later-ran');
    const later = fixture(dir, 'marker.cjs', MARKER);
    const started = Date.now();
    const code = await runGate('test-lane', [
      { name: 'never-closes', cmd: `${NODE} ${noClose}` },
      { name: 'later', cmd: `${NODE} ${later} ${marker}` },
    ], { stdio: 'pipe', timeoutMsFor: () => 300, termGraceMs: 200 });
    expect(code).toBe(125); // NOT 124: settlement was never proven
    expect(existsSync(marker)).toBe(false);
    // the battery's terminal grace (5s) had to elapse before the verdict; the grandchild
    // holds the pipe for 12s, so a prompt `close` cannot be what resolved this
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(Date.now() - started).toBeLessThan(11_000);
  }, 30_000);

  it('external SIGTERM -> 143 (128+n) and NO later stage runs', async () => {
    const dir = tmp.make('signal');
    const marker = join(dir, 'later-ran');
    const announce = announcePath(dir, 'hang-announce');
    const hang = fixture(dir, 'hang.cjs', ANNOUNCING_HANG);
    const later = fixture(dir, 'marker.cjs', MARKER);
    const runner = fixture(dir, 'runner.ts', [
      `import { runGate } from ${JSON.stringify(join(ROOT, 'scripts', 'push-gate.ts'))};`,
      'const code = await runGate("test-lane", [',
      `  { name: "hangs", cmd: ${JSON.stringify(`${NODE} ${hang} ${announce} yes`)} },`,
      `  { name: "later", cmd: ${JSON.stringify(`${NODE} ${later} ${marker}`)} },`,
      '], { stdio: "ignore", timeoutMsFor: () => 60_000 });',
      'process.exit(code);',
    ].join('\n'));

    // Detached, so this test owns a process group it may kill: a negative pid is only
    // a group id when the child leads one.
    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', runner], { stdio: 'ignore', detached: true });
    let readiness: { outcome: Promise<Readiness>; close: () => void } | undefined;
    try {
      // Observe the terminal state BEFORE signalling, so an exit that happens
      // before or during the readiness wait is captured rather than missed.
      let exitCode: number | null | undefined;
      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (c) => {
          exitCode = c;
          resolve(c);
        });
      });

      readiness = waitForReadiness(announce, READINESS_DEADLINE_MS, exited);
      const outcome = await readiness.outcome;
      if (outcome.state !== 'ready') {
        throw new Error(`fixture never entered the hanging step (${outcome.state}${outcome.state === 'exited' ? ` code ${String(outcome.code)}` : ''})`);
      }
      expect(announcedPid(announce)).toBeGreaterThan(0); // the fixture's own pid, not a guess

      child.kill('SIGTERM');
      const code = await exited;
      expect(code).toBe(143); // 128 + SIGTERM(15)
      expect(exitCode).toBe(143); // and the pre-registered observation saw the same exit
      expect(existsSync(marker)).toBe(false); // the later stage never started
    } finally {
      readiness?.close();
      await settleOwnedForest(child, announce);
    }
  }, 30_000);

  it('a live child that never announces readiness is refused at the deadline, and its whole forest is proved gone', async () => {
    const dir = tmp.make('no-ready');
    const announce = announcePath(dir, 'hang-announce'); // announces its pid, never the ready line
    const hang = fixture(dir, 'hang.cjs', ANNOUNCING_HANG);
    const runner = fixture(dir, 'runner.ts', [
      `import { runGate } from ${JSON.stringify(join(ROOT, 'scripts', 'push-gate.ts'))};`,
      'const code = await runGate("test-lane", [',
      `  { name: "hangs", cmd: ${JSON.stringify(`${NODE} ${hang} ${announce}`)} },`,
      '], { stdio: "ignore", timeoutMsFor: () => 60_000 });',
      'process.exit(code);',
    ].join('\n'));

    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', runner], { stdio: 'ignore', detached: true });
    let readiness: { outcome: Promise<Readiness>; close: () => void } | undefined;
    let settlement: { runnerGone: boolean; stepGone: boolean } | undefined;
    try {
      const exited = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
      readiness = waitForReadiness(announce, READINESS_DEADLINE_MS, exited);

      const outcome = await readiness.outcome;
      expect(outcome).toEqual({ state: 'deadline' }); // refused, not left pending
      expect(announcedPid(announce)).toBeGreaterThan(0); // the step really did start
      expect(markerText(announce)).not.toContain('ready'); // and never announced readiness
      expect(child.exitCode).toBeNull(); // the runner was live the whole time
      expect(child.signalCode).toBeNull();
    } finally {
      readiness?.close();
      settlement = await settleOwnedForest(child, announce);
    }
    // Proof, not a claim: the runner's group and the step's own detached group each
    // have no live member left. Killing the runner alone would have left the second.
    expect(settlement).toEqual({ runnerGone: true, stepGone: true });
    expect(child.signalCode).toBe('SIGKILL'); // settlement observed, not assumed
  }, 30_000);
});

describe('derived bound reaches the outer invocation', () => {
  const batteryStep: GateStep = { name: 'curated-tests', cmd: 'npm test', bound: 'battery' };
  const plainStep: GateStep = { name: 'typecheck', cmd: 'npm run typecheck' };

  it('a valid override is honored for a battery-bound step, plus the TERM grace and settle', () => {
    const env = { WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS: '300000' };
    expect(stepTimeoutMs(batteryStep, env)).toBe(300_000 + STEP_TERM_GRACE_MS + STEP_SETTLE_MS);
    // a non-battery step ignores the battery bound entirely
    expect(stepTimeoutMs(plainStep, env)).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });

  it('an invalid override falls back to the default step bound (the battery refuses, so the default applies)', () => {
    const env = { WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS: '2147483648' };
    expect(stepTimeoutMs(batteryStep, env)).toBe(DEFAULT_STEP_TIMEOUT_MS + STEP_TERM_GRACE_MS + STEP_SETTLE_MS);
  });

  it('gateLifetimeMs sums every step at its bound plus grace and settle', () => {
    const env = { WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS: '300000' };
    const steps = [batteryStep, plainStep];
    const expected = (300_000 + STEP_TERM_GRACE_MS + STEP_SETTLE_MS + STEP_TERM_GRACE_MS + STEP_SETTLE_MS)
      + (DEFAULT_STEP_TIMEOUT_MS + STEP_TERM_GRACE_MS + STEP_SETTLE_MS);
    expect(gateLifetimeMs(steps, env)).toBe(expected);
  });

  it('the pre-push wrapper bound tracks the override (derived, not hardcoded)', () => {
    const base = gateCommandTimeoutMs('branch', {});
    const overridden = gateCommandTimeoutMs('branch', { WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS: '300000' });
    expect(base).toBeGreaterThan(overridden); // 30-min default > 5-min override for the battery step
    expect(base - overridden).toBe(30 * 60 * 1000 - 300_000);
  });

  it('the battery CLI REFUSES an invalid override: EX_USAGE, and no test run', async () => {
    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', BATTERY], {
      env: { ...process.env, WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS: 'abc', PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(64); // EX_USAGE
    expect(stderr).toContain('CONFIG ERROR');
  }, 30_000);
});
