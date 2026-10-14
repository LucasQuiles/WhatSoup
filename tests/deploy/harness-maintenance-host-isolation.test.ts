import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/** True while `pid` is a live, non-zombie process. */
function alive(pid: number): boolean {
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
  const stat = ps.stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
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

  it('kills what the run leaves behind in its process group', () => {
    const h = harness();
    const pidFile = path.join(h.home, 'orphan.pid');
    const script = faultScript(h, [[
      'update_opencode() {\n',
      `update_opencode() {\n  sleep 300 </dev/null >/dev/null 2>&1 &\n  echo $! > "${pidFile}"\n`,
    ]]);
    run(h, [], {}, script);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
    expect(alive(pid)).toBe(false);
  }, T);
});
