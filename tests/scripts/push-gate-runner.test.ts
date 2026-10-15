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
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { gateLifetimeMs, runGate, stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS, STEP_SETTLE_MS, STEP_TERM_GRACE_MS, type GateStep } from '../../scripts/push-gate.ts';
import { gateCommandTimeoutMs } from '../../scripts/pre-push-guard.ts';
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
const MARKER = 'require("node:fs").writeFileSync(process.argv[2],"ran");';
// A parent that forks a DETACHED grandchild inheriting its stdio pipe, then blocks: the
// group kill reaches the parent's group only, and `close` never fires because the
// grandchild still holds fd1. That is the unresolved-reap shape, not a plain timeout.
// The hold (12s) must OUTLAST the battery's terminal grace (5s) or `close` would arrive
// first and the verdict would legitimately be a timeout instead. Self-cleaning: the
// grandchild releases and exits on its own, it is not a leak.
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
    const hang = fixture(dir, 'hang.cjs', HANG);
    const marker = join(dir, 'later-ran');
    const later = fixture(dir, 'marker.cjs', MARKER);
    const runner = fixture(dir, 'runner.ts', [
      `import { runGate } from ${JSON.stringify(join(ROOT, 'scripts', 'push-gate.ts'))};`,
      'const code = await runGate("test-lane", [',
      `  { name: "hangs", cmd: ${JSON.stringify(`${NODE} ${hang}`)} },`,
      `  { name: "later", cmd: ${JSON.stringify(`${NODE} ${later} ${marker}`)} },`,
      '], { stdio: "ignore", timeoutMsFor: () => 60_000 });',
      'process.exit(code);',
    ].join('\n'));

    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', runner], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // let it enter the hanging step
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(143); // 128 + SIGTERM(15)
    expect(existsSync(marker)).toBe(false); // the later stage never started
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
