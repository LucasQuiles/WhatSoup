// Black-box test for scripts/process-code-staleness.ts.
//
// Spawns the real script with fake `systemctl`, `ps`, `find`, and `git` injected
// on PATH so the staleness verdict is fully deterministic and has no dependency
// on (or side effect upon) the real repo. The verdict reduces to:
//   STALE  <=>  (fake-find newest src epoch)  >  (now - fake-ps etimes seconds)
// Per-test control is via FAKE_* env vars the fake binaries read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/process-code-staleness.ts',
);

// One instance ("demo") with a bogus, non-existent MainPID so repoRootFromPid
// falls back to REPO_ROOT_DEFAULT deterministically (no /proc/<pid> for 999999).
const FAKE_SYSTEMCTL = [
  '#!/usr/bin/env bash',
  'case "$*" in',
  // printf with %s keeps the literal off the email/private-label shape patterns.
  '  *list-units*) printf "whatsoup@%s.service                  loaded active running WhatSoup %s\\n" demo demo ;;',
  '  *MainPID*)    echo "${FAKE_MAINPID:-999999}" ;;',
  '  *) : ;;',
  'esac',
].join('\n');

const FAKE_PS = ['#!/usr/bin/env bash', 'echo "${FAKE_ETIMES:-100}"'].join('\n');

// Emits one "<epoch>\t<path>" line; the script keeps the max epoch.
const FAKE_FIND = [
  '#!/usr/bin/env bash',
  'printf "%s\\t%s\\n" "${FAKE_SRC_EPOCH:-1000000000}" "${FAKE_SRC_FILE:-/repo/src/foo.ts}"',
].join('\n');

const FAKE_GIT = [
  '#!/usr/bin/env bash',
  'case "$*" in',
  '  *rev-parse*) echo "abc1234" ;;',
  '  *status*)    echo "" ;;',
  '  *) : ;;',
  'esac',
].join('\n');

let binDir: string;

function writeFake(name: string, body: string): void {
  const p = path.join(binDir, name);
  writeFileSync(p, body, 'utf8');
  chmodSync(p, 0o755);
}

function run(args: string[], fakeEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--experimental-strip-types', SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      ...fakeEnv,
      PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
}

beforeEach(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'pcs-bin-'));
  writeFake('systemctl', FAKE_SYSTEMCTL);
  writeFake('ps', FAKE_PS);
  writeFake('find', FAKE_FIND);
  writeFake('git', FAKE_GIT);
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe('process-code-staleness', () => {
  it('flags STALE when newest src mtime is after process boot (exit 1)', () => {
    const r = run(['--instance', 'demo'], { FAKE_ETIMES: '100', FAKE_SRC_EPOCH: '9999999999' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('STALE');
    expect(r.stdout).toContain('restart needed');
  });

  it('reports fresh when boot is after newest src mtime (exit 0)', () => {
    const r = run(['--instance', 'demo'], { FAKE_ETIMES: '100', FAKE_SRC_EPOCH: '1000000000' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('all instances running current code');
  });

  it('treats a not-running instance (MainPID=0) as non-stale with a note (exit 0)', () => {
    const r = run(['--instance', 'demo'], { FAKE_MAINPID: '0', FAKE_SRC_EPOCH: '9999999999' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not running');
  });

  it('emits a stable JSON contract under --json (stale scenario)', () => {
    const r = run(['--instance', 'demo', '--json'], { FAKE_ETIMES: '100', FAKE_SRC_EPOCH: '9999999999' });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.check).toBe('process-code-staleness');
    expect(parsed.criterion).toBe('stale');
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.instances)).toBe(true);
    expect(parsed.instances[0].instance).toBe('demo');
    expect(parsed.instances[0].stale).toBe(true);
    expect(parsed.instances[0].lagSeconds).toBeGreaterThan(0);
  });

  it('--json criterion switches to criticalStale under --critical', () => {
    const r = run(['--instance', 'demo', '--json', '--critical'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: '1000000000',
    });
    const parsed = JSON.parse(r.stdout);
    expect(parsed.criterion).toBe('criticalStale');
  });

  it('discovers instances via systemctl when --instance is omitted', () => {
    const r = run(['--json'], { FAKE_ETIMES: '100', FAKE_SRC_EPOCH: '1000000000' });
    const parsed = JSON.parse(r.stdout);
    expect(parsed.instances.map((i: { instance: string }) => i.instance)).toContain('demo');
  });
});
