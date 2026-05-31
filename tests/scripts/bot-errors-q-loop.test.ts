import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Reads a numeric module-level constant from a python script without executing main().
function pyConst(script: string, name: string): number {
  const code = [
    'import importlib.util',
    `spec = importlib.util.spec_from_file_location("m", "${script}")`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `print(getattr(m, "${name}"))`,
  ].join('\n');
  return Number(execFileSync('python3', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }).trim());
}

// Mirrors the watchdog --max-q-loop-age default expression without invoking parse_args.
function watchdogMaxQLoopAge(): number {
  return Number(
    execFileSync('python3', ['-c', 'import os; print(int(os.environ.get("BOT_ERRORS_MAX_Q_LOOP_AGE", "600")))'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim(),
  );
}

describe('bot-errors-q-loop cadence invariant', () => {
  const qLoop = 'deploy/scripts/bot-errors-q-loop.py';

  it('keeps max idle backoff strictly below the watchdog stale threshold with margin', () => {
    const maxIdle = pyConst(qLoop, 'MAX_IDLE_WAIT_SECONDS');
    const watchdog = watchdogMaxQLoopAge();
    // A healthy idle loop refreshes its heartbeat every <= maxIdle (+ poll jitter).
    // The watchdog must not flag it stale, so require a safety margin.
    expect(maxIdle).toBeLessThan(watchdog);
    expect(watchdog - maxIdle).toBeGreaterThanOrEqual(60);
  });

  it('idle backoff schedule never reaches the watchdog threshold', () => {
    // compute_wait idle branch: min(MAX_IDLE_WAIT_SECONDS, IDLE_WAIT_SECONDS + cycles*60)
    const idle = pyConst(qLoop, 'IDLE_WAIT_SECONDS');
    const maxIdle = pyConst(qLoop, 'MAX_IDLE_WAIT_SECONDS');
    const watchdog = watchdogMaxQLoopAge();
    for (let cycles = 1; cycles <= 1000; cycles += 1) {
      const wait = Math.min(maxIdle, idle + cycles * 60);
      expect(wait).toBeLessThan(watchdog);
    }
  });
});
