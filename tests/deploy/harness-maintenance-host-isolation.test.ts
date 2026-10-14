import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';

import {
  T,
  buildNativeFixture,
  cleanupHarnesses,
  events,
  faultScript,
  makeHarness,
  portableInstance,
  run,
  writeExec,
  type Harness,
} from './harness-maintenance-fixture-helper.ts';

// The harness must never reach a host command. A normal run executes `opencode upgrade` with the
// first opencode on its PATH, and that PATH includes the pinned node's directory. On a host whose
// node directory also holds a real opencode, the old fixture (WHATSOUP_NODE_BIN = the host node)
// ran a real upgrade, and a timeout left it running after the test.

beforeAll(buildNativeFixture);
afterAll(cleanupHarnesses);

function harness(): Harness {
  const h = makeHarness();
  portableInstance(h, 'alpha');
  return h;
}

/**
 * A host-like node directory: the real node next to an npm-installed opencode that only records
 * its arguments. It stands in for a host opencode and can never run a real upgrade.
 */
function poisonNodeDir(h: Harness): { node: string; log: string } {
  const root = path.join(h.home, 'host-node');
  const log = path.join(h.home, 'poison.log');
  const pkgDir = path.join(root, 'lib/node_modules/opencode-ai');
  mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.0.0' }));
  writeExec(path.join(pkgDir, 'bin/opencode'), ['#!/bin/sh', `printf 'opencode %s\\n' "$*" >> "${log}"`, 'echo 1.0.0', 'exit 0', ''].join('\n'));
  symlinkSync(path.join(pkgDir, 'bin/opencode'), path.join(root, 'bin/opencode'));
  symlinkSync(process.execPath, path.join(root, 'bin/node'));
  return { node: path.join(root, 'bin/node'), log };
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/**
 * One `ps` field of `pid`, or null when ps reports that no such process exists (exit 1, no
 * stdout, no stderr). Any other result is a failed observation and throws: it proves nothing
 * about the process, so it must never read as "gone".
 */
function psField(pid: number, field: string, ps = 'ps'): string | null {
  const r = spawnSync(ps, ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout ?? '').trim();
  const err = (r.stderr ?? '').trim();
  const clean = !r.error && r.signal === null;
  if (clean && r.status === 0 && out !== '') return out;
  if (clean && r.status === 1 && out === '' && err === '') return null;
  const why = r.error?.message ?? `status ${r.status} signal ${r.signal} stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)}`;
  throw new Error(`cannot observe pid ${pid} with ${ps}: ${why}`);
}

/** True while `pid` is a live, non-zombie process; throws when ps cannot tell. */
function alive(pid: number, ps = 'ps'): boolean {
  const stat = psField(pid, 'stat', ps);
  return stat !== null && !stat.startsWith('Z');
}

/**
 * Fallback for a regression that leaves the orphan running. It sends SIGKILL only after ps shows
 * the orphan's unique argv. The check and the kill are two steps, not one atomic kernel call, so a
 * pid reused in the gap between them could still be signalled; the argv check narrows that window
 * but does not close it. Bounded; throws if the orphan survives.
 */
function settleOrphan(pidFile: string, argv: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  const ours = (): boolean => alive(pid) && psField(pid, 'args') === argv;
  if (!(pid > 0) || !ours()) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 5_000;
  while (ours() && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  if (ours()) throw new Error(`orphan ${pid} (${argv}) survived the fallback SIGKILL`);
  console.warn(`fallback settled orphan ${pid} (${argv}) with SIGKILL`);
}

describe('harness-maintenance fixture host isolation', () => {
  it('links the pinned node into a harness-owned directory that holds nothing else', () => {
    const h = makeHarness();
    const dir = path.dirname(h.env.WHATSOUP_NODE_BIN!);
    expect(dir.startsWith(h.home + path.sep)).toBe(true);
    expect(readdirSync(dir)).toEqual(['node']);
    expect(realpathSync(h.env.WHATSOUP_NODE_BIN!)).toBe(realpathSync(process.execPath));
  });

  it('runs no opencode from a host node directory, which a run pinned to it would upgrade', () => {
    const h = harness();
    const poison = poisonNodeDir(h);

    const isolated = run(h);
    expect(lines(poison.log)).toEqual([]);
    expect(events(isolated, 'opencode').map((e) => e.status)).not.toContain('current');

    // Positive control: pinned to the host-like directory, the same run executes its opencode.
    const exposed = run(h, [], { WHATSOUP_NODE_BIN: poison.node });
    expect(lines(poison.log)).toContain('opencode upgrade');
    expect(events(exposed, 'opencode').at(-1)).toMatchObject({ status: 'current', before: '1.0.0' });
  }, 2 * T);

  it('observes a live process and a reaped one, and fails closed when ps cannot observe', () => {
    const h = makeHarness();
    expect(alive(process.pid)).toBe(true);
    const reaped = spawnSync('true');
    expect(reaped.pid).toBeGreaterThan(0);
    expect(alive(reaped.pid)).toBe(false);
    const fakePs = (name: string, body: string): string => {
      const file = path.join(h.home, name);
      writeExec(file, `#!/bin/sh\n${body}\n`);
      return file;
    };
    for (const ps of [
      path.join(h.home, 'no-such-ps'),
      fakePs('ps-error', 'echo "ps: failure" >&2; exit 2'),
      fakePs('ps-exit1-stderr', 'echo "ps: cannot read process table" >&2; exit 1'),
      fakePs('ps-signal', 'kill -KILL $$'),
      fakePs('ps-silent', 'exit 0'),
    ]) {
      expect(() => alive(process.pid, ps)).toThrow(/cannot observe/);
    }
  });

  it('kills what the run leaves behind in its process group', () => {
    const h = harness();
    const pidFile = path.join(h.home, 'orphan.pid');
    // The unique argv lets the fallback tell this orphan apart from a process that reuses its pid.
    const name = `hm-orphan-${randomUUID()}`;
    onTestFinished(() => settleOrphan(pidFile, `${name} 300`), 15_000);
    const script = faultScript(h, [[
      'update_opencode() {\n',
      `update_opencode() {\n  (exec -a "${name}" sleep 300 </dev/null >/dev/null 2>&1) &\n  echo $! > "${pidFile}"\n`,
    ]]);
    run(h, [], {}, script);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
    expect(alive(pid)).toBe(false);
  }, T);
});
