/**
 * full-suite-battery (round-17 finding 5): the externally bounded runner must kill a
 * hung child's WHOLE process group at the wall-clock bound and report a truthful
 * non-zero exit — the enforcement that was missing when a synchronous fixture wedged
 * a worker for ~72 minutes. Uses real child processes and real time: a fake timer
 * cannot advance an external process's wall clock.
 */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildVitestArgs, runBoundedBattery } from '../../scripts/full-suite-battery.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const NODE = process.execPath;
const tmp = trackTmpDirs('battery-', { base: realpathSync(tmpdir()) });

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): this test observes
 * whether a REAL grandchild writes a marker AFTER a REAL wall-clock bound. Fake timers
 * cannot advance an external process's clock, and the only condition to poll (the
 * marker file) is the very absence the test asserts.
 */
function TIMING(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

describe('runBoundedBattery (externally bounded full-suite runner)', () => {
  it('a fast clean child reports outcome:passed and wrappedExit 0', async () => {
    const r = await runBoundedBattery({ command: NODE, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000, stdio: 'ignore' });
    expect(r).toMatchObject({ outcome: 'passed', timedOut: false, exitCode: 0, wrappedExit: 0 });
  }, 30_000);

  it('a fast NON-ZERO child reports outcome:failed and preserves the real exit code', async () => {
    const r = await runBoundedBattery({ command: NODE, args: ['-e', 'process.exit(7)'], timeoutMs: 10_000, stdio: 'ignore' });
    expect(r).toMatchObject({ outcome: 'failed', timedOut: false, exitCode: 7, wrappedExit: 7 });
  }, 30_000);

  it('FALSIFIER: a child that outruns the bound is INCONCLUSIVE (timedOut), wrappedExit 124 — not a pass, not a code failure', async () => {
    const dir = tmp.make('bound');
    const blocker = join(dir, 'blocker.cjs');
    // A child that blocks forever (a listening server keeps the event loop alive) —
    // a naive runner would wait indefinitely.
    writeFileSync(blocker, 'require("node:net").createServer(function(){}).listen(0,"127.0.0.1");');
    const start = Date.now();
    const r = await runBoundedBattery({ command: NODE, args: [blocker], timeoutMs: 500, stdio: 'ignore' });
    const elapsed = Date.now() - start;
    expect(r).toMatchObject({ outcome: 'timedOut', timedOut: true, wrappedExit: 124 });
    expect(elapsed).toBeLessThan(10_000); // bounded — did NOT run forever
  }, 30_000);

  it('a signalled child reports 128 + signal number (SIGKILL → 137), not a bare 128', async () => {
    const dir = tmp.make('signal');
    const selfkill = join(dir, 'selfkill.cjs');
    writeFileSync(selfkill, 'process.kill(process.pid, "SIGKILL");');
    const r = await runBoundedBattery({ command: NODE, args: [selfkill], timeoutMs: 10_000, stdio: 'ignore' });
    expect(r).toMatchObject({ outcome: 'failed', signal: 'SIGKILL', wrappedExit: 137 }); // 128 + 9
  }, 30_000);

  it('FALSIFIER: the bound kills the whole GROUP — a hung grandchild cannot outlive it', async () => {
    const dir = tmp.make('group');
    const marker = join(dir, 'grandchild-marker');
    const grandchild = join(dir, 'grandchild.cjs');
    const parent = join(dir, 'parent.cjs');
    // grandchild: 900ms after spawn, write the marker (no try/catch — a group SIGKILL
    // at the 300ms bound reaches it first, so the write simply never happens).
    writeFileSync(grandchild, 'const fs=require("node:fs");setTimeout(function(){fs.writeFileSync(process.argv[2],"escaped")},900);');
    // parent: fork a same-group grandchild, then block forever so the bound fires.
    writeFileSync(parent, `const cp=require("node:child_process");const m=process.argv[2];cp.spawn(process.execPath,[${JSON.stringify(grandchild)},m],{stdio:"ignore"});require("node:net").createServer(function(){}).listen(0,"127.0.0.1");`);
    const r = await runBoundedBattery({ command: NODE, args: [parent, marker], timeoutMs: 300, stdio: 'ignore' });
    expect(r.timedOut).toBe(true);
    await TIMING(1_200); // let real time pass the grandchild's 900ms timer
    expect(existsSync(marker)).toBe(false); // the whole group was reaped — no escape
  }, 30_000);

  it('FALSIFIER (finding 3): a grandchild is reaped even after the child exits 0 CLEANLY — no false pass with a surviving descendant', async () => {
    const dir = tmp.make('clean-reap');
    const marker = join(dir, 'grandchild-marker');
    const grandchild = join(dir, 'grandchild.cjs');
    const parent = join(dir, 'parent.cjs');
    // grandchild: write the marker 900ms after spawn (no try/catch — a group reap on the
    // parent's clean close reaches it first, so the write never happens).
    writeFileSync(grandchild, 'const fs=require("node:fs");setTimeout(function(){fs.writeFileSync(process.argv[2],"escaped")},900);');
    // parent: fork a same-group grandchild, then EXIT 0 IMMEDIATELY (does NOT time out).
    writeFileSync(parent, `const cp=require("node:child_process");const m=process.argv[2];const gc=cp.spawn(process.execPath,[${JSON.stringify(grandchild)},m],{stdio:"ignore"});gc.unref();process.exit(0);`);
    const r = await runBoundedBattery({ command: NODE, args: [parent, marker], timeoutMs: 10_000, stdio: 'ignore' });
    expect(r).toMatchObject({ outcome: 'passed', timedOut: false, wrappedExit: 0 }); // the child exited 0 — a naive runner stops here
    await TIMING(1_200); // let real time pass the grandchild's 900ms timer
    expect(existsSync(marker)).toBe(false); // reaped on close — the descendant did NOT survive the clean exit
  }, 30_000);

  it('FALSIFIER (finding 4): when the child never closes (an escaped descendant holds the stdio pipe), the bound resolves NON-ZERO via the terminal grace — never a false 0', async () => {
    const dir = tmp.make('no-close');
    const parent = join(dir, 'parent.cjs');
    // The parent forks a DETACHED grandchild in its OWN process group that INHERITS the
    // runner's stdout pipe (fd1) and stays alive, then blocks so the bound fires. On the
    // bound, killGroup(-parentPid) reaps the parent's group but NOT the escaped grandchild,
    // which keeps the pipe open — so the child's `close` never fires. WITHOUT an
    // UNCONDITIONAL, non-unref'd terminal grace the promise would hang and Node would exit 0.
    writeFileSync(
      parent,
      [
        'const cp=require("node:child_process");',
        // detached:true → own group (escapes the group reap); stdio inherit → holds parent fd1
        // (the runner pipe). The grandchild blocks synchronously (bounded, no timer) so it holds
        // the pipe past the grace, then exits on its own — self-cleaning, not a leak.
        'const gc=cp.spawn(process.execPath,["-e","Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500)"],{detached:true,stdio:"inherit"});',
        'gc.unref();',
        'require("node:net").createServer(function(){}).listen(0,"127.0.0.1");', // block so the bound fires
      ].join('\n'),
    );
    const start = Date.now();
    // graceMs (600) < the grandchild's hold (2500ms): the terminal GRACE must resolve FIRST.
    // WITHOUT an unconditional non-unref'd grace the runner would instead wait for the delayed
    // `close` (~2500ms) and report timedOut/124 — so these strict assertions falsify a regression.
    const r = await runBoundedBattery({ command: NODE, args: [parent], timeoutMs: 300, stdio: 'pipe', graceMs: 600 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.outcome).toBe('inconclusive'); // resolved via the terminal grace, NOT the delayed close
    expect(r.wrappedExit).toBe(125); // NEVER a false 0; the grace's inconclusive exit
    expect(elapsed).toBeLessThan(2_000); // grace (600ms) fired well before the grandchild's 2500ms release
  }, 30_000);
});

describe('buildVitestArgs (round-19 F5 regression: --pool default must not collide with a caller pool)', () => {
  // vitest's CAC parser rejects a duplicated single-value option:
  //   Error: Expected a single value for option "--pool <pool>", received ["forks","forks"]
  // F5 rewired `npm test` (and coverage:check) through this battery with --pool=forks
  // hardcoded, so every gate/CI caller that ALSO passes --pool=forks arg-crashed. The builder
  // must add the forks default ONLY when the caller named no pool.
  it('adds --pool=forks exactly once when the caller names no pool (default preserved)', () => {
    const args = buildVitestArgs(['tests/x.test.ts']);
    expect(args.filter((a) => a === '--pool=forks')).toHaveLength(1);
    expect(args).toContain('run');
    expect(args[args.length - 1]).toBe('tests/x.test.ts'); // passthrough preserved after `run`
  });

  it('does NOT add a second --pool when the caller already passed --pool=forks (the F5 crash)', () => {
    const args = buildVitestArgs(['tests/x.test.ts', '--pool=forks']);
    const pools = args.filter((a) => a === '--pool' || a.startsWith('--pool='));
    expect(pools).toEqual(['--pool=forks']); // exactly one — the caller's, not a duplicate
  });

  it('honors a caller pool other than forks in the space form without adding the forks default', () => {
    const args = buildVitestArgs(['--pool', 'threads', 'tests/x.test.ts']);
    expect(args).not.toContain('--pool=forks');
    expect(args.filter((a) => a === '--pool')).toHaveLength(1); // caller's --pool survives, singular
  });

  it('does NOT treat --poolOptions.* as a pool selection (forks default still added)', () => {
    const args = buildVitestArgs(['--poolOptions.forks.singleFork', 'true']);
    expect(args.filter((a) => a === '--pool=forks')).toHaveLength(1); // configures a pool, does not choose one
  });
});
