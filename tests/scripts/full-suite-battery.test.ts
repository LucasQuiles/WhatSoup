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

import { runBoundedBattery } from '../../scripts/full-suite-battery.ts';
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
  it('a fast clean child reports timedOut:false and wrappedExit 0', async () => {
    const r = await runBoundedBattery({ command: NODE, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000, stdio: 'ignore' });
    expect(r).toMatchObject({ timedOut: false, exitCode: 0, wrappedExit: 0 });
  }, 30_000);

  it('a fast NON-ZERO child preserves the real exit code', async () => {
    const r = await runBoundedBattery({ command: NODE, args: ['-e', 'process.exit(7)'], timeoutMs: 10_000, stdio: 'ignore' });
    expect(r).toMatchObject({ timedOut: false, exitCode: 7, wrappedExit: 7 });
  }, 30_000);

  it('FALSIFIER: a child that outruns the bound is KILLED and reports wrappedExit 124 (not a 72-minute wedge)', async () => {
    const dir = tmp.make('bound');
    const blocker = join(dir, 'blocker.cjs');
    // A child that blocks forever (a listening server keeps the event loop alive) —
    // a naive runner would wait indefinitely.
    writeFileSync(blocker, 'require("node:net").createServer(function(){}).listen(0,"127.0.0.1");');
    const start = Date.now();
    const r = await runBoundedBattery({ command: NODE, args: [blocker], timeoutMs: 500, stdio: 'ignore' });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.wrappedExit).toBe(124);
    expect(elapsed).toBeLessThan(10_000); // bounded — did NOT run forever
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
});
